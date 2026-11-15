// scripts/gamedata.mjs
//
// Builds a "name -> icon / kind / class / talent tree" index from the game
// client's own data tables (DB2 files), so skill, talent and item icons do not
// depend on Wowhead's rate-limited search. Wowhead stays as the fallback for
// names this index does not know, and as a cross-check for names it does.
//
// DATA SOURCE
//   wago.tools republishes the client tables per build as CSV:
//     GET https://wago.tools/api/builds                      -> known builds
//     GET https://wago.tools/db2/<Table>/csv?build=<version> -> one table
//   WoW: Forever is the product "wowf" (versions like 1.60.1.70938).
//   Tables used:
//     SpellName            id -> spell name
//     SpellMisc            spell id -> icon file id (several rows per spell)
//     ManifestInterfaceData file id -> icon file name (the CDN's icon name)
//     Talent, TalentTab    talent rank spell ids; tree name and class mask
//     SkillLine, SkillLineAbility   which spells a class skill line teaches
//     ItemSparse, Item     item name and icon file id
//
// DESIGN
//   * Columns are always located by header name, never by position: the
//     tables are wide and Blizzard adds columns between builds.
//   * The CSV files are tens of MB, so they are parsed as a stream and only
//     the needed columns of each row are kept (see csvRows). Tables are
//     processed one at a time and the raw text is never held in full.
//   * The result of a build is a small plain-JSON object cached on disk as
//     <cacheDir>/index-<version>.json; later runs with the same build only
//     fetch the (tiny) builds list. makeGameIndex() wraps that JSON in a
//     synchronous lookup function.
//   * Nothing here throws at the top level: loadGameIndex() returns null on any
//     failure so the caller can fall back to Wowhead alone.
//
// CLI:  node scripts/gamedata.mjs ["Name one" "Name two" ...]

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** Honest User-Agent sent on every request. */
export const USER_AGENT = 'wow-4ever-changes/0.1 (+https://github.com/RQalgo/wow-4ever-changes)';

/** wago.tools endpoints. */
export const BUILDS_URL = 'https://wago.tools/api/builds';
export const tableUrl = (table, version) =>
  `https://wago.tools/db2/${table}/csv?build=${encodeURIComponent(version)}`;

/** Per-request timeout (covers reading the body too) and pause between tables. */
const REQUEST_TIMEOUT_MS = 60_000;
const TABLE_PAUSE_MS = 1000;

/** SkillLine.CategoryID value that marks class skill lines ("Frost", "Holy"...). */
const CATEGORY_CLASS = 7;

/** Icon used by the client when a spell has no real icon. */
const QUESTION_MARK_ICON = 'inv_misc_questionmark';

/** Maximum entries kept per normalised name. */
const MAX_ENTRIES_PER_NAME = 6;

/**
 * Class bit masks as used by ClassMask columns: bit = 1 << (classId - 1).
 * WoW: Forever has no death knight / monk / demon hunter, so they are absent.
 */
const CLASS_MASKS = {
  warrior: 1,
  paladin: 2,
  hunter: 4,
  rogue: 8,
  priest: 16,
  shaman: 64,
  mage: 128,
  warlock: 256,
  druid: 1024,
};

/**
 * Class slug for a ClassMask value, or null when the mask is 0 (everyone),
 * has several bits set (shared between classes) or is not a known class.
 * @param {number|string} mask
 * @returns {string|null}
 */
export function classFromMask(mask) {
  const m = Number(mask);
  if (!Number.isInteger(m) || m <= 0) return null;
  for (const [slug, bit] of Object.entries(CLASS_MASKS)) {
    if (m === bit) return slug; // exact match => exactly this one bit
  }
  return null;
}

/**
 * Normalises a skill/item name for use as an index key: lower-case, curly
 * apostrophes turned straight, whitespace collapsed, trimmed.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Talent-tree slug from the tab's display name: "Beast Mastery" ->
 * "beast-mastery". "Feral Combat" is stored as "feral" to match the slugs the
 * parser uses for headings (scripts/parse.mjs).
 * @param {string} name
 * @returns {string}
 */
export function treeSlug(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/['‘’]/g, '') // drop apostrophes instead of splitting on them
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === 'feral-combat' ? 'feral' : slug;
}
