/**
 * scripts/sources.mjs — the list of data sources and how to turn each one
 * into days of changes (docs/SCHEMA.md, "Version 2").
 *
 * `data/sources.json` is a hand-edited array; each entry says what kind of
 * day it produces ("hotfix" | "patch") and how to read it:
 *
 *   - type "news-rolling":    Blizzard's rolling news post with date headings
 *                             inside the page (the WoW: Forever Hotfixes post).
 *   - type "discourse-topic": a Blizzard forum topic; each staff post is one
 *                             edition of patch notes, dated by its creation
 *                             time in US Pacific time.
 *
 * The orchestrator (scripts/update.mjs) calls `loadSources` once and
 * `fetchSourceDays` per source. The network and parser functions are passed
 * in (`deps`), so tests can run every branch with stubs; missing deps are
 * loaded lazily from scripts/fetch.mjs and scripts/parse.mjs.
 */
import { readFile } from 'node:fs/promises';

/** Day kinds a source may produce. */
export const SOURCE_KINDS = new Set(['hotfix', 'patch']);

/** Source types this module knows how to read. */
export const SOURCE_TYPES = new Set(['news-rolling', 'discourse-topic']);

/**
 * Check the shape of a parsed sources list. Throws on the first problem with
 * a message naming the file and the entry, so a typo in the hand-edited file
 * is obvious from the workflow log.
 *
 * @param {unknown} list Parsed JSON.
 * @param {string} [where='sources'] Name used in error messages (file path).
 * @returns {Array<{kind:string,type:string,url:string,title?:string|null}>} `list`, validated.
 * @throws {Error} when the list or an entry is malformed.
 */
export function validateSources(list, where = 'sources') {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${where}: expected a non-empty JSON array of sources`);
  }
  list.forEach((s, i) => {
    const at = `${where}[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at}: expected an object`);
    if (!SOURCE_KINDS.has(s.kind)) throw new Error(`${at}: "kind" must be one of ${[...SOURCE_KINDS].join(', ')} (got ${JSON.stringify(s.kind)})`);
    if (!SOURCE_TYPES.has(s.type)) throw new Error(`${at}: "type" must be one of ${[...SOURCE_TYPES].join(', ')} (got ${JSON.stringify(s.type)})`);
    let ok = false;
    try { ok = typeof s.url === 'string' && /^https?:$/.test(new URL(s.url).protocol); } catch { /* not a URL */ }
    if (!ok) throw new Error(`${at}: "url" must be an http(s) URL (got ${JSON.stringify(s.url)})`);
    if (s.title !== undefined && s.title !== null && typeof s.title !== 'string') {
      throw new Error(`${at}: "title" must be a string or null`);
    }
  });
  return list;
}

/**
 * Read and validate the sources list.
 *
 * @param {string} [path='data/sources.json'] File to read.
 * @returns {Promise<Array<{kind:string,type:string,url:string,title?:string|null}>>}
 * @throws {Error} if the file is missing, not JSON, or malformed. Unlike a
 *   corrupt changes.json this is fatal: without sources there is nothing to do.
 */
export async function loadSources(path = 'data/sources.json') {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read sources list ${path}: ${err.message}`, { cause: err });
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error(`Sources list ${path} is not valid JSON: ${err.message}`, { cause: err });
  }
  return validateSources(list, path);
}
