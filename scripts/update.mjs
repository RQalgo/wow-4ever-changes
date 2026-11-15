// scripts/update.mjs
//
// Pipeline orchestrator for the WoW: Forever changes site.
//
// Design: this file only wires the other pipeline stages together
// (sources -> fetch -> parse -> merge -> icons -> tags -> write) and holds the small
// pieces of logic that belong to no single stage: merging fresh days into
// the previously published data, change detection, and the safety checks
// that stop a broken source from wiping good data. The stages themselves
// (scripts/sources.mjs, fetch.mjs, parse.mjs, icons.mjs) are injected through
// `deps`, so the tests can use stubs and this file can be imported even when
// the real modules are not present.
//
// Sources come from data/sources.json (docs/SCHEMA.md "Version 2"): the
// rolling hotfix post and Blizzard forum topics with patch notes. A source
// that fails is skipped and its stored days are kept.
//
// The output format is the contract in docs/SCHEMA.md.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { addTags as defaultAddTags } from './tags.mjs';

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
 * @returns {Promise<{loadSources: Function, fetchSourceDays: Function,
 *   fetchPost: Function, fetchJson: Function, parseHotfixHtml: Function,
 *   parsePatchPost: Function, addSubjects: Function, addTags: Function,
 *   loadGameIndex: Function}>}
 */
async function loadDefaultDeps() {
  const [fetchMod, parseMod, iconsMod, sourcesMod] = await Promise.all([
    import('./fetch.mjs'),
    import('./parse.mjs'),
    import('./icons.mjs'),
    import('./sources.mjs'),
  ]);
  return {
    loadSources: sourcesMod.loadSources,
    fetchSourceDays: sourcesMod.fetchSourceDays,
    fetchPost: fetchMod.fetchPost,
    fetchJson: fetchMod.fetchJson,
    parseHotfixHtml: parseMod.parseHotfixHtml,
    parsePatchPost: parseMod.parsePatchPost,
    addSubjects: iconsMod.addSubjects,
    addTags: defaultAddTags,
    // The game-client data index is a separate module that may be missing or
    // fail; runUpdate treats any problem as "client data unavailable".
    loadGameIndex: async (opts) => (await import('./gamedata.mjs')).loadGameIndex(opts),
  };
}

/**
 * Decide which sources to process, from the injected deps:
 *   - `deps.sources`: an explicit list (tests);
 *   - `deps.loadSources`: a loader, called with `sourcesPath` (production);
 *   - only `deps.SOURCE_URL` (the pre-v2 stub style): that one hotfix post;
 *   - otherwise the real loader from scripts/sources.mjs.
 *
 * @param {object} deps
 * @param {string} sourcesPath
 * @returns {Promise<Array<{kind:string,type:string,url:string,title?:string|null}>>}
 */
async function resolveSources(deps, sourcesPath) {
  if (deps.sources) return deps.sources;
  if (deps.loadSources) return deps.loadSources(sourcesPath);
  if (deps.SOURCE_URL) return [{ kind: 'hotfix', type: 'news-rolling', url: deps.SOURCE_URL }];
  const { loadSources } = await import('./sources.mjs');
  return loadSources(sourcesPath);
}

/**
 * Bring a stored day up to schema v2. Days written before v2 have no
 * `kind`; they all came from the hotfix post, so they get kind "hotfix",
 * no title and the hotfix post as their link. Other days are unchanged.
 *
 * @param {object} day Stored day.
 * @param {string|null} hotfixUrl URL of the hotfix source.
 * @returns {object}
 */
function upgradeStoredDay(day, hotfixUrl) {
  if (day.kind) return day;
  // Rebuild so the new fields sit in schema order after `date`.
  const { date, ...rest } = day;
  return { date, kind: 'hotfix', title: day.title ?? null, sourceUrl: day.sourceUrl ?? hotfixUrl, ...rest };
}

/**
 * Load the game-client data index through the injectable `loadGameIndex` dep.
 * A missing dep (tests that pass their own stubs), a thrown error or a null
 * result all mean "no index": one log line, and the run continues with
 * Wowhead only (`gameIndex = null`).
 *
 * @param {object} d  deps
 * @param {(msg: string) => void} log
 * @returns {Promise<object|null>}
 */
async function loadIndexSafely(d, log) {
  if (!d.loadGameIndex) return null;
  try {
    const index = await d.loadGameIndex({ log });
    if (index) return index;
    log('client data unavailable (no index returned); using Wowhead only');
  } catch (err) {
    log(`client data unavailable (${err.message}); using Wowhead only`);
  }
  return null;
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
 * Run the whole pipeline once: for every source in data/sources.json fetch
 * and parse its days, merge them with the existing data, resolve icons, and
 * write `outPath` only if the content changed.
 *
 * Safety: a source that throws, or yields no days or no changes, almost
 * certainly broke (layout change, wrong page, outage). It is logged and
 * skipped, and the days previously stored for it are kept, because
 * mergeDays retains every stored day the fresh data does not replace. Only
 * when EVERY source fails do we throw and leave the file untouched, rather
 * than publishing a site with no fresh data at all.
 *
 * @param {object} [options]
 * @param {string} [options.outPath='data/changes.json'] output file
 * @param {string} [options.sourcesPath='data/sources.json'] sources list
 * @param {object} [options.deps] injectable stages (all optional except
 *   addSubjects when deps is given):
 *   { sources | loadSources | SOURCE_URL, fetchSourceDays, fetchPost,
 *     fetchJson, parseHotfixHtml, parsePatchPost, addSubjects, addTags,
 *     loadGameIndex }
 *   (addTags defaults to scripts/tags.mjs; loadGameIndex defaults to
 *   scripts/gamedata.mjs only when no `deps` are given at all, so stubbed
 *   tests never touch the network)
 *   — see resolveSources for how the source list is chosen; the fetch/parse
 *   stages are passed through to fetchSourceDays.
 * @param {() => Date} [options.now] clock, injectable for tests
 * @param {(msg: string) => void} [options.log] progress logger
 * @returns {Promise<{changed: boolean, days: number, changes: number}>}
 * @throws {Error} when no source produced changes ("refusing to overwrite")
 */
export async function runUpdate({
  outPath = 'data/changes.json',
  sourcesPath = 'data/sources.json',
  deps,
  now = () => new Date(),
  log = console.error,
} = {}) {
  const d = deps ?? (await loadDefaultDeps());
  const fetchSourceDays = d.fetchSourceDays ?? (await import('./sources.mjs')).fetchSourceDays;
  const sources = await resolveSources(d, sourcesPath);
  const hotfixUrl = sources.find((s) => s.kind === 'hotfix')?.url ?? null;

  // 1. Previous output (tolerates missing/corrupt), upgraded to schema v2.
  const existing = await readExisting(outPath);
  const previousDays = (existing?.days ?? []).map((day) => upgradeStoredDay(day, hotfixUrl));

  // 2. Fetch and parse each source. Failures are collected, not thrown, so
  //    one broken source does not block the others.
  const stageDeps = {
    fetchPost: d.fetchPost,
    fetchJson: d.fetchJson,
    parseHotfixHtml: d.parseHotfixHtml,
    parsePatchPost: d.parsePatchPost,
    log,
  };
  const freshDays = [];
  const failures = [];
  for (const source of sources) {
    const name = `${source.kind} source ${source.url}`;
    log(`Fetching ${name}`);
    let days;
    try {
      days = (await fetchSourceDays(source, stageDeps)) ?? [];
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      log(`Skipping ${name} (keeping its stored days): ${err.message}`);
      continue;
    }
    // 3. Per-source safety check: nothing usable means the layout changed.
    if (days.length === 0 || countChanges(days) === 0) {
      failures.push(`${name}: no days or no changes`);
      log(`Skipping ${name} (keeping its stored days): parse produced no days or no changes`);
      continue;
    }
    freshDays.push(...days);
  }
  const okCount = sources.length - failures.length;
  log(`Sources: ${okCount}/${sources.length} ok`);
  if (okCount === 0) {
    throw new Error(
      `No source produced any changes; refusing to overwrite ${outPath} ` +
        `(the source layout may have changed). ${failures.join(' | ')}`,
    );
  }

  // 4. Merge with what we already had, then resolve icons for everything.
  //    Icon lookups are cached, so re-processing old days is cheap.
  const merged = mergeDays(previousDays, freshDays);
  const gameIndex = await loadIndexSafely(d, log);
  const withSubjects = await d.addSubjects(merged, { gameIndex });
  // Tags are recomputed for ALL days, including stored days no source has any
  // more, so that a change of the rules revises the whole history on the next
  // run (sameContent then sees the difference and the file is rewritten).
  const days = (d.addTags ?? defaultAddTags)(withSubjects);

  // 5. Assemble the document per docs/SCHEMA.md. generatedAt is whole
  //    seconds (no milliseconds) to match the documented format. `source`
  //    stays the hotfix post (pre-v2 readers); `sources` lists them all.
  const output = {
    generatedAt: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { title: 'WoW: Forever Hotfixes', url: hotfixUrl },
    sources: sources.map((s) => ({ kind: s.kind, title: s.title ?? null, url: s.url })),
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
