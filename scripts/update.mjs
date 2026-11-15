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
 * Kind of a stored day; data written before schema v2 has no `kind` and is
 * all hotfixes.
 *
 * @param {{kind?: string}} day
 * @returns {string} "hotfix" | "patch"
 */
export function dayKind(day) {
  return day?.kind ?? 'hotfix';
}

/** Sort rank on the same date: the patch comes before the hotfix. */
const KIND_ORDER = { patch: 0, hotfix: 1 };

/**
 * Order two days: newest date first; on the same date, patch before hotfix
 * (docs/SCHEMA.md v2). Unknown kinds sort after the known ones.
 *
 * @param {{date: string, kind?: string}} a
 * @param {{date: string, kind?: string}} b
 * @returns {number}
 */
export function compareDays(a, b) {
  // ISO dates (YYYY-MM-DD) sort correctly as plain strings.
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (KIND_ORDER[dayKind(a)] ?? 9) - (KIND_ORDER[dayKind(b)] ?? 9);
}

/**
 * Merge freshly fetched days into the previously stored days. Sources may
 * eventually drop old dates, but the site should keep showing them, so:
 *   - a day is identified by `date` + `kind` (a missing kind is "hotfix"):
 *     a patch and a hotfix on the same date are two separate days;
 *   - a previous day whose key is absent from the fresh days is retained;
 *   - for a key present in both, the fresh version wins (Blizzard may edit
 *     an existing day's entries).
 *
 * @param {Array<{date: string, kind?: string}>} previousDays days from the existing file
 * @param {Array<{date: string, kind?: string}>} freshDays    days from the new fetch
 * @returns {Array<{date: string, kind?: string}>} merged days, newest first,
 *   patch before hotfix on the same date
 */
export function mergeDays(previousDays, freshDays) {
  // Inserting previous first then fresh means fresh overwrites any day with
  // the same key.
  const byKey = new Map();
  const key = (day) => `${day.date}|${dayKind(day)}`;
  for (const day of previousDays ?? []) byKey.set(key(day), day);
  for (const day of freshDays ?? []) byKey.set(key(day), day);
  return [...byKey.values()].sort(compareDays);
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

/**
 * CLI entry point: `node scripts/update.mjs`. Prints a one-line summary and
 * sets a non-zero exit code on failure so CI marks the run as failed.
 *
 * @returns {Promise<void>}
 */
async function main() {
  try {
    const r = await runUpdate();
    console.log(
      `${r.changed ? 'updated' : 'unchanged'}: ${r.days} days, ${r.changes} changes`,
    );
  } catch (err) {
    console.error(`update failed: ${err.message}`);
    process.exit(1);
  }
}

// Run only when executed directly, not when imported (e.g. by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
