// test/update.test.mjs
//
// Unit tests for scripts/update.mjs (run with `node --test`).
// The real fetch/parse/icons modules are replaced by in-memory stubs, so the
// tests need no network and no other pipeline module. Each runUpdate test
// writes into its own temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeDays, sameContent, runUpdate } from '../scripts/update.mjs';

/**
 * Build a minimal schema-shaped day with n changes.
 * @param {string} date ISO date
 * @param {number} [n=1] number of changes
 * @param {string} [text='x'] change text
 */
const day = (date, n = 1, text = 'x') => ({
  date,
  label: date,
  changes: Array.from({ length: n }, (_, i) => ({
    id: `${date}-${String(i).padStart(3, '0')}`,
    text,
    subjects: [],
  })),
});

test('mergeDays adds a new day and sorts newest first', () => {
  const merged = mergeDays([day('2026-11-10')], [day('2026-11-13'), day('2026-11-12')]);
  assert.deepEqual(merged.map((d) => d.date), ['2026-11-13', '2026-11-12', '2026-11-10']);
});

test('mergeDays retains previous days dropped from the source', () => {
  const merged = mergeDays([day('2026-11-01'), day('2026-11-02')], [day('2026-11-13')]);
  assert.deepEqual(merged.map((d) => d.date), ['2026-11-13', '2026-11-02', '2026-11-01']);
});

test('mergeDays lets the fresh version of a same-date day win', () => {
  const merged = mergeDays([day('2026-11-13', 1, 'old')], [day('2026-11-13', 2, 'new')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].changes.length, 2);
  assert.equal(merged[0].changes[0].text, 'new');
});

test('mergeDays handles empty inputs and does not mutate them', () => {
  const prev = [day('2026-11-01'), day('2026-11-03')];
  const copy = structuredClone(prev);
  assert.deepEqual(mergeDays([], []), []);
  assert.deepEqual(mergeDays(prev, []).map((d) => d.date), ['2026-11-03', '2026-11-01']);
  assert.deepEqual(prev, copy);
});

test('sameContent ignores generatedAt but not other differences', () => {
  const a = { generatedAt: 'A', source: { url: 'u' }, days: [day('2026-11-13')] };
  const b = { generatedAt: 'B', source: { url: 'u' }, days: [day('2026-11-13')] };
  assert.equal(sameContent(a, b), true);
  assert.equal(sameContent(a, { ...b, days: [day('2026-11-13', 2)] }), false);
  assert.equal(sameContent(a, null), false);
});

/** Create a temp dir; returns [dir, outPath]. */
async function tmpOut() {
  const dir = await mkdtemp(join(tmpdir(), 'update-test-'));
  return [dir, join(dir, 'changes.json')];
}

/**
 * Stub deps. `parsedDays` is what the fake parser returns; addSubjects marks
 * each change so we can see it ran.
 */
function stubDeps(parsedDays) {
  return {
    SOURCE_URL: 'https://example.test/post',
    fetchPost: async () => '<html></html>',
    parseHotfixHtml: () => ({ days: parsedDays }),
    addSubjects: async (days) =>
      days.map((d) => ({
        ...d,
        changes: d.changes.map((c) => ({ ...c, subjects: [{ name: 'S', type: 'spell', icon: 'i' }] })),
      })),
  };
}

const quiet = () => {};
const fixedNow = () => new Date('2026-11-15T01:02:03.456Z');

test('runUpdate happy path writes schema-shaped pretty JSON', async () => {
  const [dir, out] = await tmpOut();
  try {
    const r = await runUpdate({ outPath: out, deps: stubDeps([day('2026-11-13', 2)]), now: fixedNow, log: quiet });
    assert.deepEqual(r, { changed: true, days: 1, changes: 2 });
    const text = await readFile(out, 'utf8');
    assert.ok(text.endsWith('}\n'), 'trailing newline');
    assert.ok(text.includes('\n  "days"'), '2-space indent');
    const data = JSON.parse(text);
    assert.equal(data.generatedAt, '2026-11-15T01:02:03Z');
    assert.deepEqual(data.source, { title: 'WoW: Forever Hotfixes', url: 'https://example.test/post' });
    assert.equal(data.days[0].changes[0].subjects[0].icon, 'i');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate merges with previous file and keeps dropped days', async () => {
  const [dir, out] = await tmpOut();
  try {
    await runUpdate({ outPath: out, deps: stubDeps([day('2026-11-01')]), now: fixedNow, log: quiet });
    const r = await runUpdate({ outPath: out, deps: stubDeps([day('2026-11-13')]), now: fixedNow, log: quiet });
    assert.equal(r.days, 2);
    const data = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(data.days.map((d) => d.date), ['2026-11-13', '2026-11-01']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate does not write when only generatedAt would differ', async () => {
  const [dir, out] = await tmpOut();
  try {
    const deps = stubDeps([day('2026-11-13')]);
    await runUpdate({ outPath: out, deps, now: fixedNow, log: quiet });
    const before = await readFile(out, 'utf8');
    const mtimeBefore = (await stat(out)).mtimeMs;
    // Small pause so a rewrite would produce a different mtime.
    await new Promise((r) => setTimeout(r, 20));
    const r = await runUpdate({ outPath: out, deps, now: () => new Date('2027-01-01T00:00:00Z'), log: quiet });
    assert.equal(r.changed, false);
    assert.equal(await readFile(out, 'utf8'), before, 'content untouched');
    assert.equal((await stat(out)).mtimeMs, mtimeBefore, 'mtime untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate refuses to overwrite when the parse has zero days', async () => {
  const [dir, out] = await tmpOut();
  try {
    await writeFile(out, '{"keep":"me","days":[]}\n');
    await assert.rejects(
      runUpdate({ outPath: out, deps: stubDeps([]), now: fixedNow, log: quiet }),
      /refusing to overwrite/,
    );
    assert.equal(await readFile(out, 'utf8'), '{"keep":"me","days":[]}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate refuses to overwrite when days contain zero changes', async () => {
  const [dir, out] = await tmpOut();
  try {
    await assert.rejects(
      runUpdate({ outPath: out, deps: stubDeps([day('2026-11-13', 0)]), now: fixedNow, log: quiet }),
      /refusing to overwrite/,
    );
    await assert.rejects(stat(out), { code: 'ENOENT' }); // nothing created
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate tolerates a corrupt existing file', async () => {
  const [dir, out] = await tmpOut();
  try {
    await writeFile(out, '{ not json');
    const r = await runUpdate({ outPath: out, deps: stubDeps([day('2026-11-13')]), now: fixedNow, log: quiet });
    assert.equal(r.changed, true);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).days.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
