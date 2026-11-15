// scripts/update.mjs
//
// Pipeline orchestrator for the WoW: Forever changes site.
//
// Design: this file only wires the other pipeline stages together
// (fetch -> parse -> merge -> icons -> write) and holds the small pieces of
// logic that belong to no single stage: merging a fresh parse into the
// previously published data, change detection, and the safety checks that
// stop a broken parse from wiping good data. The stages themselves
// (scripts/fetch.mjs, parse.mjs, icons.mjs) are injected through `deps`, so
// the tests can use stubs and this file can be imported even when the real
// modules are not present.
//
// The output format is the contract in docs/SCHEMA.md.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/**
 * Merge a fresh parse of the rolling source post into the previously stored
 * days. The source may eventually drop old dates, but the site should keep
 * showing them, so:
 *   - a previous day whose date is absent from the fresh parse is retained;
 *   - for a date present in both, the fresh version wins (Blizzard may edit
 *     an existing day's entries).
 *
 * @param {Array<{date: string}>} previousDays days from the existing file
 * @param {Array<{date: string}>} freshDays    days from the new parse
 * @returns {Array<{date: string}>} merged days, newest first
 */
export function mergeDays(previousDays, freshDays) {
  // Keyed by ISO date; inserting previous first then fresh means fresh
  // overwrites any same-date entry.
  const byDate = new Map();
  for (const day of previousDays ?? []) byDate.set(day.date, day);
  for (const day of freshDays ?? []) byDate.set(day.date, day);

  // ISO dates (YYYY-MM-DD) sort correctly as plain strings; descending
  // order gives newest first.
  return [...byDate.values()].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
}

/**
 * Compare two changes.json objects ignoring `generatedAt`, which changes on
 * every run and would otherwise cause a needless commit each time.
 * Deep comparison is key-order independent.
 *
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean} true when the content is equal
 */
export function sameContent(a, b) {
  if (!a || !b) return false;
  // Strip generatedAt from shallow copies; never mutate the inputs.
  const { generatedAt: _a, ...restA } = a;
  const { generatedAt: _b, ...restB } = b;
  return isDeepStrictEqual(restA, restB);
}

/**
 * Read the previously generated changes.json. A missing or corrupt file is
 * not fatal: the run simply starts from empty data (and will rewrite it).
 *
 * @param {string} path file to read
 * @returns {Promise<object|null>} parsed object, or null if unusable
 */
async function readExisting(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    // Guard against valid JSON of the wrong shape (e.g. `[]` or `null`).
    return data && typeof data === 'object' && Array.isArray(data.days)
      ? data
      : null;
  } catch {
    return null; // ENOENT or JSON syntax error
  }
}

/**
 * Load the real pipeline stages. Done lazily with dynamic import() so that
 * importing this module (e.g. from tests) never requires them to exist.
 *
 * @returns {Promise<{fetchPost: Function, parseHotfixHtml: Function,
 *   addSubjects: Function, SOURCE_URL: string}>}
 */
async function loadDefaultDeps() {
  const [fetchMod, parseMod, iconsMod] = await Promise.all([
    import('./fetch.mjs'),
    import('./parse.mjs'),
    import('./icons.mjs'),
  ]);
  return {
    fetchPost: fetchMod.fetchPost,
    parseHotfixHtml: parseMod.parseHotfixHtml,
    addSubjects: iconsMod.addSubjects,
    SOURCE_URL: fetchMod.SOURCE_URL,
  };
}

/**
 * Total number of individual changes across all days.
 *
 * @param {Array<{changes?: unknown[]}>} days
 * @returns {number}
 */
function countChanges(days) {
  return days.reduce((n, d) => n + (d.changes?.length ?? 0), 0);
}

/**
 * Run the whole pipeline once: fetch, parse, merge with the existing data,
 * resolve icons, and write `outPath` only if the content changed.
 *
 * Safety: a parse that yields no days or no changes almost certainly means
 * the source layout changed or the fetch returned the wrong page. In that
 * case we throw and leave the existing file untouched, rather than
 * publishing an empty site.
 *
 * @param {object} [options]
 * @param {string} [options.outPath='data/changes.json'] output file
 * @param {object} [options.deps] injectable stages:
 *   { fetchPost, parseHotfixHtml, addSubjects, SOURCE_URL }
 * @param {() => Date} [options.now] clock, injectable for tests
 * @param {(msg: string) => void} [options.log] progress logger
 * @returns {Promise<{changed: boolean, days: number, changes: number}>}
 * @throws {Error} when the parse is empty ("refusing to overwrite")
 */
export async function runUpdate({
  outPath = 'data/changes.json',
  deps,
  now = () => new Date(),
  log = console.error,
} = {}) {
  const { fetchPost, parseHotfixHtml, addSubjects, SOURCE_URL } =
    deps ?? (await loadDefaultDeps());

  // 1. Previous output (tolerates missing/corrupt).
  const existing = await readExisting(outPath);
  const previousDays = existing?.days ?? [];

  // 2. Fetch and parse the source post.
  log(`Fetching ${SOURCE_URL}`);
  const html = await fetchPost(SOURCE_URL);
  const parsed = parseHotfixHtml(html);
  const freshDays = parsed?.days ?? [];

  // 3. Safety check, before anything is written.
  if (freshDays.length === 0 || countChanges(freshDays) === 0) {
    throw new Error(
      'Parse produced no days or no changes; refusing to overwrite ' +
        `${outPath} (the source layout may have changed).`,
    );
  }

  // 4. Merge with what we already had, then resolve icons for everything.
  //    Icon lookups are cached, so re-processing old days is cheap.
  const merged = mergeDays(previousDays, freshDays);
  const days = await addSubjects(merged);

  // 5. Assemble the document per docs/SCHEMA.md. generatedAt is whole
  //    seconds (no milliseconds) to match the documented format.
  const output = {
    generatedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { title: 'WoW: Forever Hotfixes', url: SOURCE_URL },
    days,
  };
  const summary = { days: days.length, changes: countChanges(days) };

  // 6. Skip the write when nothing but the timestamp differs, so the
  //    scheduled workflow does not create empty commits.
  if (sameContent(existing, output)) {
    log('No content changes; leaving file untouched.');
    return { changed: false, ...summary };
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n');
  log(`Wrote ${outPath}`);
  return { changed: true, ...summary };
}
