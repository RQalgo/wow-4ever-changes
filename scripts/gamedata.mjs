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

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180, streaming)
// ---------------------------------------------------------------------------

/**
 * Incremental CSV tokenizer. Feed it text chunks with push(); each call returns
 * the records (arrays of strings) that were completed by that chunk. Call
 * end() after the last chunk to get a final record that had no trailing
 * newline. Chunk boundaries may fall anywhere, even inside a quoted field or
 * between the two quotes of an escaped quote.
 *
 * State machine, per character:
 *   unquoted : ',' ends the field; '\n' / '\r' ends the record; a '"' as the
 *              very first character of a field switches to quoted mode (a
 *              quote elsewhere in an unquoted field is kept literally).
 *   quoted   : everything is literal (commas, newlines) until a '"'. A '"'
 *              followed by another '"' is one literal quote; a '"' followed by
 *              anything else closes the quoted part.
 * Blank lines are skipped. "\r\n", "\n" and a lone "\r" all end a record.
 */
class CsvTokenizer {
  constructor() {
    this.record = []; // fields finished so far in the current record
    this.field = ''; // text of the field being read
    this.inQuotes = false;
    this.quotePending = false; // chunk ended right after a '"' seen in quoted mode
    this.skipLF = false; // chunk ended right after a '\r': swallow a following '\n'
    this.fieldStarted = false; // any character (or opening quote) seen in this field
  }

  /** Finishes the current field. */
  _endField() {
    this.record.push(this.field);
    this.field = '';
    this.fieldStarted = false;
  }

  /**
   * Finishes the current record and returns it, or null for a blank line.
   * @returns {string[]|null}
   */
  _endRecord() {
    // A blank line is a record with a single empty, never-started field.
    const blank = this.record.length === 0 && !this.fieldStarted && this.field === '';
    let out = null;
    if (!blank) {
      this._endField();
      out = this.record;
    }
    this.record = [];
    this.field = '';
    this.fieldStarted = false;
    return out;
  }

  /**
   * @param {string} chunk
   * @returns {string[][]} records completed by this chunk
   */
  push(chunk) {
    const out = [];
    const n = chunk.length;
    let i = 0;

    // Resume decisions that were waiting for the first character of this chunk.
    if (this.skipLF) {
      this.skipLF = false;
      if (chunk.charCodeAt(0) === 10) i = 1;
    }
    if (this.quotePending && i < n) {
      this.quotePending = false;
      if (chunk.charCodeAt(i) === 34) {
        this.field += '"'; // "" => literal quote, still in quoted mode
        i++;
      } else {
        this.inQuotes = false; // the quote closed the quoted part
      }
    }

    while (i < n) {
      if (this.inQuotes) {
        // Jump straight to the next quote; everything before it is literal.
        const q = chunk.indexOf('"', i);
        if (q === -1) {
          this.field += chunk.slice(i);
          i = n;
          break;
        }
        this.field += chunk.slice(i, q);
        i = q + 1;
        if (i >= n) {
          this.quotePending = true; // cannot tell "" from closing quote yet
          break;
        }
        if (chunk.charCodeAt(i) === 34) {
          this.field += '"';
          i++;
        } else {
          this.inQuotes = false;
        }
        continue;
      }

      // Unquoted mode: copy a run of ordinary characters in one slice.
      let j = i;
      while (j < n) {
        const c = chunk.charCodeAt(j);
        if (c === 44 || c === 10 || c === 13 || c === 34) break;
        j++;
      }
      if (j > i) {
        this.field += chunk.slice(i, j);
        this.fieldStarted = true;
        i = j;
        if (i >= n) break;
      }
      const c = chunk.charCodeAt(i);
      i++;
      if (c === 44) {
        this.fieldStarted = true; // an empty field before a comma still counts
        this._endField();
      } else if (c === 10 || c === 13) {
        const rec = this._endRecord();
        if (rec) out.push(rec);
        if (c === 13) {
          if (i < n) {
            if (chunk.charCodeAt(i) === 10) i++;
          } else {
            this.skipLF = true;
          }
        }
      } else {
        // c === 34, a double quote
        if (!this.fieldStarted && this.field === '') {
          this.inQuotes = true; // opening quote of a quoted field
          this.fieldStarted = true;
        } else {
          this.field += '"'; // stray quote inside an unquoted field: literal
        }
      }
    }
    return out;
  }

  /**
   * Flushes a last record that had no trailing newline.
   * @returns {string[][]}
   */
  end() {
    const rec = this._endRecord();
    return rec ? [rec] : [];
  }
}

/**
 * Turns the first record into a header and each later record into an object
 * keyed by header name. Only the columns listed in `columns` are kept when
 * given (keeps wide tables such as SpellMisc cheap). `required` columns must
 * exist in the header or an Error is thrown.
 */
class RowBuilder {
  /**
   * @param {{columns?: string[], required?: string[]}} opts
   */
  constructor({ columns, required = [] } = {}) {
    this.columns = columns ? new Set(columns) : null;
    this.required = required;
    /** @type {Array<[string, number]>|null} [name, index] pairs to keep */
    this.picks = null;
  }

  /**
   * @param {string[]} rec one tokenized record
   * @returns {object|null} null for the header record itself
   */
  add(rec) {
    if (!this.picks) {
      // First record = header. Strip a UTF-8 BOM from the first name.
      const header = rec.map((h, k) => (k === 0 ? h.replace(/^﻿/, '') : h).trim());
      for (const name of this.required) {
        if (!header.includes(name)) {
          throw new Error(`missing column "${name}" (header: ${header.slice(0, 12).join(',')}…)`);
        }
      }
      this.picks = [];
      header.forEach((name, idx) => {
        if (!this.columns || this.columns.has(name)) this.picks.push([name, idx]);
      });
      return null;
    }
    const row = {};
    for (const [name, idx] of this.picks) row[name] = rec[idx] ?? '';
    return row;
  }
}

/**
 * Parses a whole CSV text (convenience for tests and small inputs).
 * @param {string} text
 * @param {{columns?: string[], required?: string[]}} [opts]
 * @returns {object[]} one object per data row, keyed by header name
 */
export function parseCsv(text, opts) {
  const tok = new CsvTokenizer();
  const builder = new RowBuilder(opts);
  const rows = [];
  const take = (recs) => {
    for (const rec of recs) {
      const row = builder.add(rec);
      if (row) rows.push(row);
    }
  };
  take(tok.push(String(text).replace(/^﻿/, '')));
  take(tok.end());
  return rows;
}

/**
 * Streams CSV rows as objects keyed by header name.
 * @param {string|AsyncIterable<string|Uint8Array>|Iterable<string|Uint8Array>} source
 *   a string, or any (async) iterable of chunks: a fetch Response body, a
 *   fs.createReadStream, an array of strings...
 * @param {{columns?: string[], required?: string[]}} [opts]
 *   columns: only keep these columns; required: throw if one is missing
 * @yields {object}
 */
export async function* csvRows(source, opts) {
  const tok = new CsvTokenizer();
  const builder = new RowBuilder(opts);
  // StringDecoder keeps multi-byte UTF-8 characters intact across chunk edges.
  const decoder = new StringDecoder('utf8');
  const chunks = typeof source === 'string' ? [source] : source;
  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
    for (const rec of tok.push(text)) {
      const row = builder.add(rec);
      if (row) yield row;
    }
  }
  const tail = decoder.end();
  const recs = tail ? tok.push(tail) : [];
  recs.push(...tok.end());
  for (const rec of recs) {
    const row = builder.add(rec);
    if (row) yield row;
  }
}

// ---------------------------------------------------------------------------
// Build selection
// ---------------------------------------------------------------------------

/**
 * Picks the newest build of a product from the wago.tools /api/builds
 * response. The response is an object keyed by product whose values are
 * UNORDERED arrays of { product, version, created_at, is_bgdl, ... }; this also
 * accepts a plain top-level array. "Newest" = greatest created_at
 * ("YYYY-MM-DD HH:MM:SS" sorts correctly as text). Background-download builds
 * (is_bgdl) are ignored unless they are all there is.
 * @param {object|object[]} buildsJson
 * @param {string} [product]
 * @returns {string|null} version such as "1.60.1.70938", or null
 */
export function pickLatestBuild(buildsJson, product = 'wowf') {
  let list = [];
  if (Array.isArray(buildsJson)) {
    list = buildsJson.filter((b) => b && b.product === product);
  } else if (buildsJson && typeof buildsJson === 'object') {
    const v = buildsJson[product];
    if (Array.isArray(v)) list = v.filter((b) => b && (b.product === undefined || b.product === product));
  }
  list = list.filter((b) => typeof b.version === 'string' && b.version);
  if (list.length === 0) return null;
  // Prefer real builds over background-download ones, when any exist.
  const normal = list.filter((b) => !b.is_bgdl);
  const pool = normal.length ? normal : list;
  let best = pool[0];
  for (const b of pool) {
    if (String(b.created_at ?? '') > String(best.created_at ?? '')) best = b;
  }
  return best.version;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

/**
 * One HTTP GET with the honest User-Agent and a 60 s timeout (the timeout also
 * covers reading the body). Throws on network errors and non-2xx statuses.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function request(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'} for ${url}`);
  return res;
}

// ---------------------------------------------------------------------------
// Building the index data
// ---------------------------------------------------------------------------

/** Sort rank of entry kinds inside one name: talent first, then ability, then spell. */
const KIND_RANK = { talent: 0, ability: 1, spell: 2 };

/**
 * True when a plain spell name looks like test / internal data that the client
 * ships but players never see. Only applied to kind "spell"; talents and class
 * abilities are real by construction.
 *
 * Judgment call: the brief lists "zz" as a marker. Blizzard's convention is a
 * "zz" PREFIX ("zzOLD Frost Armor"), and a plain substring test would also
 * drop real names such as "Pizzazz", so only the prefix is matched.
 * @param {string} name
 * @returns {boolean}
 */
function isJunkSpellName(name) {
  return (
    /\((TEST|OLD|DND|NYI|PT)\)/i.test(name) ||
    name.includes('DNT') ||
    /^zz/i.test(name) ||
    name.startsWith('[')
  );
}

/**
 * Adds an entry to a name group, de-duplicating by (kind, class, tree, icon):
 * many spell ranks share a name and icon, so only the lowest id is kept. For
 * talents the rank spell ids of all merged duplicates are collected in `ids`
 * (used later to match Wowhead talents by spell id).
 * @param {Map<string, Map<string, object>>} groups name key -> dedupe key -> entry
 * @param {object} e entry with name, kind, class, tree, icon, id (+ tab for talents)
 */
function addEntry(groups, e) {
  const key = normalizeName(e.name);
  let group = groups.get(key);
  if (!group) groups.set(key, (group = new Map()));
  const dk = `${e.kind}|${e.class}|${e.tree}|${e.icon}`;
  const have = group.get(dk);
  if (e.kind === 'talent') e.ids = new Set([e.id]);
  if (!have) {
    group.set(dk, e);
    return;
  }
  if (e.kind === 'talent') for (const id of e.ids) have.ids.add(id);
  if (e.id < have.id) {
    have.id = e.id;
    have.name = e.name;
  }
}

/**
 * Turns the collected groups into the output object: drops question-mark
 * duplicates, orders entries talent -> ability -> spell (then by id), caps each
 * name at 6 entries and converts rank-id sets to sorted arrays.
 * @param {Map<string, Map<string, object>>} groups
 * @returns {Record<string, object[]>}
 */
function finalizeGroups(groups) {
  const out = {};
  for (const [key, group] of groups) {
    let list = [...group.values()];
    // A question-mark icon is only a placeholder: drop it when the same name
    // has at least one real icon.
    if (list.some((e) => e.icon !== QUESTION_MARK_ICON)) {
      list = list.filter((e) => e.icon !== QUESTION_MARK_ICON);
    }
    list.sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.id - b.id);
    out[key] = list.slice(0, MAX_ENTRIES_PER_NAME).map((e) => {
      if (e.ids) e = { ...e, ids: [...e.ids].sort((a, b) => a - b) };
      return e;
    });
  }
  return out;
}

/**
 * Downloads the needed tables for one build and builds the index data.
 * Tables are fetched one at a time (pause between them), parsed as streams and
 * reduced to small maps, so peak memory is the size of the maps, not the files.
 *
 * @param {{fetchImpl?: typeof fetch, version: string, log?: (msg: string) => void, pauseMs?: number}} opts
 * @returns {Promise<{version: string, builtAt: string,
 *   tabs: Record<string, {name: string, class: string|null, tree: string}>,
 *   spells: Record<string, object[]>, items: Record<string, object[]>}>}
 * @throws on any network, HTTP or CSV problem (loadGameIndex catches it)
 */
export async function buildGameIndexData({ fetchImpl = fetch, version, log = () => {}, pauseMs = TABLE_PAUSE_MS } = {}) {
  if (!version) throw new Error('buildGameIndexData: version is required');

  let firstTable = true;
  /** Streams one table's rows, pausing between tables to be polite. */
  async function* table(name, opts) {
    if (!firstTable && pauseMs > 0) await sleep(pauseMs);
    firstTable = false;
    log(`gamedata: downloading ${name}`);
    const res = await request(fetchImpl, tableUrl(name, version));
    try {
      yield* csvRows(res.body ?? (await res.text()), opts);
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
  }

  // --- TalentTab: tab id -> { name, class, tree } --------------------------
  /** @type {Record<string, {name: string, class: string|null, tree: string}>} */
  const tabs = {};
  /** class slug -> set of its tree slugs (to recognise tree-named skill lines) */
  const classTrees = new Map();
  for await (const r of table('TalentTab', { columns: ['ID', 'Name_lang', 'ClassMask'], required: ['ID', 'Name_lang', 'ClassMask'] })) {
    const cls = classFromMask(r.ClassMask); // several bits or 0 => null
    const tree = treeSlug(r.Name_lang);
    tabs[r.ID] = { name: r.Name_lang, class: cls, tree };
    if (cls) {
      if (!classTrees.has(cls)) classTrees.set(cls, new Set());
      classTrees.get(cls).add(tree);
    }
  }

  // --- Talent: every rank spell of every talent -> { tab } ------------------
  const rankCols = Array.from({ length: 9 }, (_, i) => `SpellRank_${i}`);
  /** @type {Map<number, number>} spell id -> talent tab id */
  const talentSpells = new Map();
  for await (const r of table('Talent', { columns: ['TabID', 'SpellID', ...rankCols], required: ['TabID'] })) {
    if (!tabs[r.TabID]) continue; // talent on an unknown tab: not a usable talent
    // SpellID is often 0 and the ranks live in SpellRank_0..8 (0 = unused).
    for (const col of ['SpellID', ...rankCols]) {
      const id = Number(r[col]);
      if (id > 0 && !talentSpells.has(id)) talentSpells.set(id, Number(r.TabID));
    }
  }

  // --- SkillLine: which skill lines are class lines (CategoryID 7) ----------
  /** @type {Map<string, string>} skill line id -> its name's tree slug */
  const classLines = new Map();
  for await (const r of table('SkillLine', { columns: ['ID', 'DisplayName_lang', 'CategoryID'], required: ['ID', 'DisplayName_lang', 'CategoryID'] })) {
    if (Number(r.CategoryID) === CATEGORY_CLASS) classLines.set(r.ID, treeSlug(r.DisplayName_lang));
  }

  // --- SkillLineAbility: spell -> { class, tree } for class abilities --------
  /** @type {Map<number, {class: string, tree: string|null}>} */
  const abilitySpells = new Map();
  for await (const r of table('SkillLineAbility', { columns: ['SkillLine', 'Spell', 'ClassMask'], required: ['SkillLine', 'Spell', 'ClassMask'] })) {
    if (!classLines.has(r.SkillLine)) continue;
    const cls = classFromMask(r.ClassMask);
    // A multi-class or class-less mask cannot say whose ability this is; the
    // spell is then treated like any other spell further down.
    if (!cls) continue;
    // Abilities learned from a tree's own skill line ("Frost" for mages) also
    // get that tree; general class lines ("Mage") leave the tree null.
    const slug = classLines.get(r.SkillLine);
    const tree = classTrees.get(cls)?.has(slug) ? slug : null;
    const id = Number(r.Spell);
    const have = abilitySpells.get(id);
    if (!have || (!have.tree && tree)) abilitySpells.set(id, { class: cls, tree });
  }

  // --- SpellName: id -> name ------------------------------------------------
  /** @type {Map<number, string>} */
  const spellNames = new Map();
  for await (const r of table('SpellName', { columns: ['ID', 'Name_lang'], required: ['ID', 'Name_lang'] })) {
    if (r.Name_lang) spellNames.set(Number(r.ID), r.Name_lang);
  }

  // --- SpellMisc: spell id -> icon file id (prefer DifficultyID 0) ----------
  /** @type {Map<number, number>} */
  const spellIconIds = new Map();
  const spellHasDiff0 = new Set();
  for await (const r of table('SpellMisc', { columns: ['ID', 'SpellID', 'DifficultyID', 'SpellIconFileDataID'], required: ['SpellIconFileDataID'] })) {
    // The spell id lives in SpellID; very old layouts only have ID.
    const spellId = Number('SpellID' in r ? r.SpellID : r.ID);
    if (!spellNames.has(spellId)) continue; // nameless spells are useless to us
    const fdid = Number(r.SpellIconFileDataID);
    if (!(fdid > 0)) continue;
    const isDiff0 = !('DifficultyID' in r) || Number(r.DifficultyID) === 0;
    if (!spellIconIds.has(spellId) || (isDiff0 && !spellHasDiff0.has(spellId))) {
      spellIconIds.set(spellId, fdid);
      if (isDiff0) spellHasDiff0.add(spellId);
    }
  }

  // --- ItemSparse + Item: item id -> name, icon file id ----------------------
  /** @type {Map<number, string>} */
  const itemNames = new Map();
  for await (const r of table('ItemSparse', { columns: ['ID', 'Display_lang'], required: ['ID', 'Display_lang'] })) {
    if (r.Display_lang) itemNames.set(Number(r.ID), r.Display_lang);
  }
  /** @type {Map<number, number>} */
  const itemIconIds = new Map();
  for await (const r of table('Item', { columns: ['ID', 'IconFileDataID'], required: ['ID', 'IconFileDataID'] })) {
    const id = Number(r.ID);
    const fdid = Number(r.IconFileDataID);
    if (itemNames.has(id) && fdid > 0) itemIconIds.set(id, fdid);
  }

  // --- ManifestInterfaceData: icon file id -> icon name ----------------------
  const needed = new Set([...spellIconIds.values(), ...itemIconIds.values()]);
  /** @type {Map<number, string>} */
  const iconNames = new Map();
  for await (const r of table('ManifestInterfaceData', { columns: ['ID', 'FilePath', 'FileName'], required: ['ID', 'FilePath', 'FileName'] })) {
    const fdid = Number(r.ID);
    if (!needed.has(fdid)) continue;
    // Icons live under Interface\ICONS\; the case and slash style vary.
    const dir = r.FilePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (dir !== 'interface/icons') continue;
    // The CDN's icon name is the file name, lower-cased, without extension.
    iconNames.set(fdid, r.FileName.replace(/\.[^.]*$/, '').toLowerCase());
  }

  // --- Assemble spell entries -------------------------------------------------
  const spellGroups = new Map();
  for (const [id, name] of spellNames) {
    const fdid = spellIconIds.get(id);
    const icon = fdid && iconNames.get(fdid);
    if (!icon) continue; // never index a spell without an icon
    const tab = talentSpells.get(id);
    const ability = abilitySpells.get(id);
    if (tab !== undefined) {
      // Talent wins over ability: class and tree come from the talent's tab.
      const t = tabs[tab];
      addEntry(spellGroups, { name, kind: 'talent', class: t.class, tree: t.tree, icon, id, tab });
    } else if (ability) {
      addEntry(spellGroups, { name, kind: 'ability', class: ability.class, tree: ability.tree, icon, id });
    } else if (!isJunkSpellName(name)) {
      addEntry(spellGroups, { name, kind: 'spell', class: null, tree: null, icon, id });
    }
  }

  // --- Assemble item entries --------------------------------------------------
  const itemGroups = new Map();
  for (const [id, name] of itemNames) {
    const icon = iconNames.get(itemIconIds.get(id));
    if (!icon) continue;
    const key = normalizeName(name);
    let group = itemGroups.get(key);
    if (!group) itemGroups.set(key, (group = new Map()));
    const have = group.get(icon); // de-duplicate by (name, icon), lowest id wins
    if (!have || id < have.id) group.set(icon, { name, icon, id });
  }
  const items = {};
  for (const [key, group] of itemGroups) {
    items[key] = [...group.values()].sort((a, b) => a.id - b.id).slice(0, MAX_ENTRIES_PER_NAME);
  }

  return { version, builtAt: new Date().toISOString(), tabs, spells: finalizeGroups(spellGroups), items };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Wraps index data in a synchronous lookup.
 * @param {{version?: string|null, spells?: object, items?: object}} data
 * @returns {{version: string|null, size: number, counts: () => object,
 *   lookup: (name: string, opts?: {classSlug?: string, preferType?: string}) => object|null}}
 */
export function makeGameIndex(data) {
  const spells = data?.spells ?? {};
  const items = data?.items ?? {};
  // Own-property check so names such as "constructor" never hit Object.prototype.
  const get = (table, key) => (Object.hasOwn(table, key) && Array.isArray(table[key]) ? table[key].filter((e) => e && e.icon) : []);

  let size = 0;
  for (const t of [spells, items]) for (const k of Object.keys(t)) size += Array.isArray(t[k]) ? t[k].length : 0;

  /** Builds the public result object for a spell entry. */
  const spellResult = (e) => {
    const r = { name: e.name, type: 'spell', kind: e.kind, class: e.class ?? null, tree: e.tree ?? null, icon: e.icon, source: e.source ?? 'client' };
    if (typeof e.verified === 'boolean') r.verified = e.verified;
    return r;
  };
  /** Builds the public result object for an item entry. */
  const itemResult = (e) => ({ name: e.name, type: 'item', kind: 'item', class: null, tree: null, icon: e.icon, source: 'client' });

  /**
   * Finds the best entry for a name.
   *   preferType 'item': an item wins when one exists.
   *   Otherwise spells are ranked: (1) talent/ability of `classSlug`,
   *   (2) talent/ability of any class, (3) any other spell; when there is
   *   no spell at all an item is returned. Entries without icon are never used.
   * Never throws.
   */
  function lookup(name, { classSlug, preferType } = {}) {
    try {
      const key = normalizeName(name);
      if (!key) return null;
      const sp = get(spells, key);
      const it = get(items, key);
      if (preferType === 'item' && it.length) return itemResult(it[0]);
      const classy = (e) => e.kind === 'talent' || e.kind === 'ability';
      const pick =
        (classSlug && sp.find((e) => classy(e) && e.class === classSlug)) ||
        sp.find(classy) ||
        sp[0];
      if (pick) return spellResult(pick);
      if (it.length) return itemResult(it[0]);
      return null;
    } catch {
      return null;
    }
  }

  /** Entry counts per kind, for diagnostics and the CLI. */
  function counts() {
    const c = { talents: 0, abilities: 0, spells: 0, items: 0 };
    for (const list of Object.values(spells)) {
      for (const e of Array.isArray(list) ? list : []) {
        if (e.kind === 'talent') c.talents++;
        else if (e.kind === 'ability') c.abilities++;
        else c.spells++;
      }
    }
    for (const list of Object.values(items)) c.items += Array.isArray(list) ? list.length : 0;
    return c;
  }

  return { version: data?.version ?? null, size, lookup, counts };
}

// ---------------------------------------------------------------------------
// Wowhead talent calculator data (cross-check and gap filler)
// ---------------------------------------------------------------------------

/** One file with the talents of every class; its keys are TalentTab ids. */
export const WOWHEAD_TALENTS_URL = 'https://nether.wowhead.com/forever/data/talents-classic';

/**
 * Starting at `start` (index of an opening "{" or "["), returns the index just
 * past the matching closing bracket, or -1. Brackets inside JSON strings are
 * ignored and backslash escapes are honoured, so descriptions containing
 * braces or \" cannot confuse it. Nothing is evaluated.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function scanJsonValue(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++; // skip the escaped character, whatever it is
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Extracts the talents from the body of the Wowhead talent data file. The file
 * is JavaScript, a series of WH.setPageData("<key>", <json>) calls; the one
 * whose key starts with "wow.talentCalcClassic" holds { talents: { <tabId>:
 * { <talentId>: { name, icon, row, col, ranks:[spellIds] } } } }. The JSON is
 * cut out by bracket scanning and parsed with JSON.parse (never eval).
 * @param {string} text
 * @returns {Array<{id: number, name: string, icon: string, tabId: number, row: number, col: number, ranks: number[]}>}
 *   empty array on any problem
 */
export function parseWowheadTalentData(text) {
  try {
    const src = String(text ?? '');
    const callRe = /WH\.setPageData\(\s*"([^"]*)"\s*,\s*/g;
    let m;
    while ((m = callRe.exec(src))) {
      if (!m[1].startsWith('wow.talentCalcClassic')) continue;
      const start = m.index + m[0].length;
      if (src[start] !== '{') continue;
      const end = scanJsonValue(src, start);
      if (end < 0) continue;
      const data = JSON.parse(src.slice(start, end));
      const out = [];
      for (const [tabId, tab] of Object.entries(data?.talents ?? {})) {
        if (!tab || typeof tab !== 'object') continue;
        for (const t of Object.values(tab)) {
          if (!t || typeof t.name !== 'string' || typeof t.icon !== 'string' || !t.name || !t.icon) continue;
          out.push({
            id: Number(t.id) || 0,
            name: t.name,
            icon: t.icon.toLowerCase(),
            tabId: Number(tabId),
            row: Number(t.row) || 0,
            col: Number(t.col) || 0,
            ranks: Array.isArray(t.ranks) ? t.ranks.map(Number).filter((n) => n > 0) : [],
          });
        }
      }
      if (out.length) return out;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Downloads and parses the Wowhead talent data (one request). Never throws.
 * @param {{fetchImpl?: typeof fetch, log?: (msg: string) => void}} [opts]
 * @returns {Promise<ReturnType<typeof parseWowheadTalentData>>}
 */
export async function fetchWowheadTalents({ fetchImpl = fetch, log = console.error } = {}) {
  try {
    const res = await request(fetchImpl, WOWHEAD_TALENTS_URL);
    const talents = parseWowheadTalentData(await res.text());
    if (talents.length === 0) log('gamedata: Wowhead talent data had no talents (format changed?)');
    return talents;
  } catch (err) {
    log(`gamedata: Wowhead talent data unavailable (${err.message})`);
    return [];
  }
}

/**
 * Merges Wowhead talents into index data (returns a copy; the input is not
 * changed, so the cached client index stays pure).
 *   - talent in both: match by tab id + normalised name, else by a shared rank
 *     spell id; entry gets verified true (icons equal, case-insensitive) or
 *     false (differ; the client icon is kept);
 *   - talent only in Wowhead: added as kind "talent", source "wowhead", with
 *     class/tree from the client's TalentTab row when that tab is known.
 * One summary line is logged for disagreements (count plus up to 10 examples).
 * @param {object} data index data from buildGameIndexData (or a stub)
 * @param {ReturnType<typeof parseWowheadTalentData>} talents
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {object} merged data
 */
export function mergeWowheadTalents(data, talents, { log = () => {} } = {}) {
  const out = { ...data, spells: structuredClone(data?.spells ?? {}), tabs: data?.tabs ?? {} };
  // rank spell id -> client talent entry, for the fallback match
  const byRankId = new Map();
  for (const list of Object.values(out.spells)) {
    for (const e of list) if (e.kind === 'talent') for (const id of e.ids ?? [e.id]) if (!byRankId.has(id)) byRankId.set(id, e);
  }

  let added = 0;
  let checked = 0;
  const mismatches = [];
  for (const w of talents) {
    const key = normalizeName(w.name);
    const list = Object.hasOwn(out.spells, key) ? out.spells[key] : [];
    let match = list.find((e) => e.kind === 'talent' && e.tab === w.tabId);
    if (!match) for (const id of w.ranks) if ((match = byRankId.get(id))) break;
    if (match) {
      checked++;
      match.verified = String(match.icon).toLowerCase() === w.icon.toLowerCase();
      if (!match.verified) mismatches.push(`${w.name} (client ${match.icon}, wowhead ${w.icon})`);
      continue;
    }
    const tab = out.tabs[w.tabId];
    const entry = {
      name: w.name, kind: 'talent', class: tab?.class ?? null, tree: tab?.tree ?? null,
      icon: w.icon, id: w.ranks[0] ?? w.id, tab: w.tabId, ids: [...w.ranks], source: 'wowhead',
    };
    if (!Object.hasOwn(out.spells, key)) out.spells[key] = [];
    out.spells[key].push(entry);
    added++;
  }
  // Keep each name ordered talent -> ability -> spell and capped.
  for (const k of Object.keys(out.spells)) {
    out.spells[k].sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.id - b.id);
    out.spells[k] = out.spells[k].slice(0, MAX_ENTRIES_PER_NAME);
  }
  if (mismatches.length) {
    log(`gamedata: ${mismatches.length} of ${checked} talent icons differ between client data and Wowhead (client kept), e.g. ${mismatches.slice(0, 10).join('; ')}`);
  }
  if (added) log(`gamedata: added ${added} talents that only Wowhead knows`);
  return out;
}

// ---------------------------------------------------------------------------
// Loading with an on-disk cache
// ---------------------------------------------------------------------------

/** How long the cached Wowhead talent file is reused. */
const WOWHEAD_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Compares dotted version strings numerically ("1.60.1.70938").
 * @returns {number} negative, zero or positive like a comparator
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Reads and sanity-checks a cached index file; null if missing or corrupt. */
async function readIndexFile(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && typeof data.spells === 'object' && typeof data.items === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** Newest readable cached index (by version), or null. */
async function readNewestCachedIndex(cacheDir) {
  let names = [];
  try {
    names = await readdir(cacheDir);
  } catch {
    return null;
  }
  const versions = names
    .map((n) => /^index-(.+)\.json$/.exec(n)?.[1])
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
  for (const v of versions) {
    const data = await readIndexFile(join(cacheDir, `index-${v}.json`));
    if (data) return data;
  }
  return null;
}

/**
 * Gets the client index data: from the cache when this build was already
 * built, otherwise built from the downloaded tables and cached. Returns null
 * after logging one line when that is impossible.
 */
async function loadClientData({ cacheDir, fetchImpl, log, pauseMs, verbose }) {
  let version = null;
  try {
    const res = await request(fetchImpl, BUILDS_URL);
    version = pickLatestBuild(await res.json());
    if (!version) throw new Error('no "wowf" build in the builds list');
  } catch (err) {
    // Builds list unreachable: any cached index is better than none.
    const cached = await readNewestCachedIndex(cacheDir);
    if (cached) {
      log(`gamedata: build list unavailable (${err.message}); using cached index ${cached.version}`);
      return cached;
    }
    log(`gamedata: client data unavailable (${err.message})`);
    return null;
  }

  const file = join(cacheDir, `index-${version}.json`);
  const cached = await readIndexFile(file);
  if (cached) return cached;

  try {
    const data = await buildGameIndexData({ fetchImpl, version, pauseMs, log: verbose ? log : () => {} });
    await mkdir(cacheDir, { recursive: true });
    // Write to a temp name first so a crash never leaves a half-written index.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
    // Keep only the newest index: delete the older index-*.json files.
    for (const n of await readdir(cacheDir)) {
      if (/^index-.+\.json$/.test(n) && n !== `index-${version}.json`) await unlink(join(cacheDir, n)).catch(() => {});
    }
    return data;
  } catch (err) {
    log(`gamedata: could not build the client index for ${version} (${err.message})`);
    return null;
  }
}

/**
 * Wowhead talents, reusing <cacheDir>/wowhead-talents.json for 24 h. When the
 * download fails a stale cache is still used. Never throws.
 */
async function loadWowheadTalents({ cacheDir, fetchImpl, log, nowMs }) {
  const file = join(cacheDir, 'wowhead-talents.json');
  let cached = null;
  try {
    const c = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(c?.talents) && c.talents.length && Number.isFinite(c.fetchedAt)) cached = c;
  } catch {
    /* no usable cache */
  }
  if (cached && nowMs() - cached.fetchedAt < WOWHEAD_CACHE_MS) return cached.talents;

  const talents = await fetchWowheadTalents({ fetchImpl, log });
  if (talents.length) {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify({ fetchedAt: nowMs(), talents }));
    } catch {
      /* a cache that cannot be written only costs a re-download next run */
    }
    return talents;
  }
  return cached ? cached.talents : [];
}

/**
 * Loads the game-data index: client tables (cached per build) merged with the
 * Wowhead talent calculator data (cached 24 h). Never throws; returns null when
 * neither source is available.
 *
 * @param {{cacheDir?: string, fetchImpl?: typeof fetch, log?: (msg: string) => void,
 *   now?: number|Date|(() => number), pauseMs?: number, verbose?: boolean}} [opts]
 *   now: clock for the Wowhead cache age (injectable for tests);
 *   verbose: also log download progress
 * @returns {Promise<ReturnType<typeof makeGameIndex>|null>}
 */
export async function loadGameIndex({
  cacheDir = '.cache/gamedata', fetchImpl = fetch, log = console.error, now = Date.now, pauseMs = TABLE_PAUSE_MS, verbose = false,
} = {}) {
  try {
    const nowMs = () => (typeof now === 'function' ? now() : Number(now instanceof Date ? now.getTime() : now));
    let data = await loadClientData({ cacheDir, fetchImpl, log, pauseMs, verbose });
    const talents = await loadWowheadTalents({ cacheDir, fetchImpl, log, nowMs });
    if (!data && talents.length === 0) return null;
    if (!data) {
      // Client tables unavailable: an index from Wowhead talents alone. Class
      // and tree are known only if some older cached index has the tab table.
      const old = await readNewestCachedIndex(cacheDir);
      data = { version: null, builtAt: new Date(nowMs()).toISOString(), tabs: old?.tabs ?? {}, spells: {}, items: {} };
      log('gamedata: using Wowhead talent data only');
    }
    if (talents.length) data = mergeWowheadTalents(data, talents, { log });
    return makeGameIndex(data);
  } catch (err) {
    log(`gamedata: unexpected failure (${err?.message ?? err})`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI:  node scripts/gamedata.mjs ["Name" ...]
// ---------------------------------------------------------------------------

/** Prints the index version, counts and the lookup result of each argument. */
async function main(names) {
  const index = await loadGameIndex({ verbose: true });
  if (!index) {
    console.log('no index available (see messages above)');
    process.exitCode = 1;
    return;
  }
  const c = index.counts();
  console.log(`version ${index.version ?? '(wowhead only)'}: ${c.talents} talents, ${c.abilities} abilities, ${c.spells} spells, ${c.items} items`);
  for (const n of names) console.log(`${n} ->`, JSON.stringify(index.lookup(n)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
