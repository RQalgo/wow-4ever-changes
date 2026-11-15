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
