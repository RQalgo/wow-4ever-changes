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
