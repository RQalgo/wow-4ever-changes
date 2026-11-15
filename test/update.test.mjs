// test/update.test.mjs
//
// Unit tests for scripts/update.mjs (run with `node --test`).
// The real fetch/parse/icons stages are replaced by in-memory stubs, so the
// tests need no network. The older tests use the pre-v2 stub style (one
// SOURCE_URL + fetchPost/parseHotfixHtml), which runs through the real
// scripts/sources.mjs; the multi-source tests stub fetchSourceDays directly.
// Each runUpdate test writes into its own temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeDays, sameContent, runUpdate, dayKind, normalizeGroupSeparators } from '../scripts/update.mjs';

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

test('mergeDays keys on date + kind: a patch and a hotfix on one date are two days', () => {
  const patch = (date, text = 'p') => ({ ...day(date, 1, text), kind: 'patch' });
  const hotfix = (date, text = 'h') => ({ ...day(date, 1, text), kind: 'hotfix' });
  const merged = mergeDays(
    [day('2026-11-02', 1, 'old hotfix, no kind'), patch('2026-11-02', 'old patch')],
    [hotfix('2026-11-02', 'new hotfix')],
  );
  // The kind-less stored day counts as a hotfix, so the fresh hotfix replaces it.
  assert.deepEqual(merged.map((d) => [d.date, d.kind, d.changes[0].text]), [
    ['2026-11-02', 'patch', 'old patch'],
    ['2026-11-02', 'hotfix', 'new hotfix'],
  ]);
});

test('mergeDays orders newest date first, and patch before hotfix on the same date', () => {
  const k = (date, kind) => ({ ...day(date), kind });
  const merged = mergeDays([k('2026-11-01', 'hotfix'), k('2026-11-13', 'hotfix')], [k('2026-11-13', 'patch'), k('2026-11-02', 'patch')]);
  assert.deepEqual(merged.map((d) => `${d.date} ${d.kind}`), [
    '2026-11-13 patch', '2026-11-13 hotfix', '2026-11-02 patch', '2026-11-01 hotfix',
  ]);
  assert.equal(dayKind({}), 'hotfix');
});

test('normalizeGroupSeparators rewrites " > " to " › " in stored groups only', () => {
  const days = [{ date: '2026-11-09', changes: [
    { id: 'a', group: 'The Drowned City > Deathless Marrow', text: 'Lowered X > Y.' },
    { id: 'b', group: 'A > B > C' },
    { id: 'c', group: null },
    { id: 'd' },
    { id: 'e', group: 'Already › fine' },
  ] }];
  assert.equal(normalizeGroupSeparators(days), days);
  assert.deepEqual(days[0].changes.map((c) => c.group), [
    'The Drowned City › Deathless Marrow', 'A › B › C', null, undefined, 'Already › fine',
  ]);
  assert.equal(days[0].changes[0].text, 'Lowered X > Y.'); // text is never touched
});

test('runUpdate normalises the separator of stored days no source returns any more', async () => {
  const [dir, out] = await tmpOut();
  try {
    const stored = { ...day('2026-10-01'), kind: 'hotfix' };
    stored.changes[0].group = 'Old Dungeon > Boss';
    await writeFile(out, JSON.stringify({ generatedAt: 'x', days: [stored] }));
    await runUpdate({ outPath: out, deps: stubDeps([day('2026-11-13')]), now: fixedNow, log: quiet });
    const data = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(data.days.find((d) => d.date === '2026-10-01').changes[0].group, 'Old Dungeon › Boss');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// --- Multiple sources (schema v2) -------------------------------------------

const HOTFIX_SRC = { kind: 'hotfix', type: 'news-rolling', url: 'https://news.test/hotfixes' };
const PATCH_SRC = { kind: 'patch', type: 'discourse-topic', url: 'https://forum.test/t/1', title: 'Beta build notes' };

/**
 * Stub deps for multi-source runs. `bySource` maps a source URL to the days
 * it returns, or to an Error it throws. addSubjects is the identity.
 */
function multiDeps(bySource, sources = [HOTFIX_SRC, PATCH_SRC]) {
  return {
    sources,
    fetchSourceDays: async (source) => {
      const r = bySource[source.url];
      if (r instanceof Error) throw r;
      return structuredClone(r ?? []);
    },
    addSubjects: async (days) => days,
  };
}

/** A v2 day of the given kind. */
const vday = (date, kind, n = 1, text = 'x') => ({
  ...day(date, n, text), kind, title: kind === 'patch' ? 'Beta build notes' : null,
  sourceUrl: kind === 'patch' ? `${PATCH_SRC.url}/4` : HOTFIX_SRC.url,
});

test('runUpdate writes days from every source, ordered, plus a sources list', async () => {
  const [dir, out] = await tmpOut();
  try {
    const deps = multiDeps({
      [HOTFIX_SRC.url]: [vday('2026-11-13', 'hotfix', 2), vday('2026-11-02', 'hotfix')],
      [PATCH_SRC.url]: [vday('2026-11-02', 'patch', 3)],
    });
    const lines = [];
    const r = await runUpdate({ outPath: out, deps, now: fixedNow, log: (m) => lines.push(m) });
    assert.deepEqual(r, { changed: true, days: 3, changes: 6 });
    const data = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(data.days.map((d) => `${d.date} ${d.kind}`), ['2026-11-13 hotfix', '2026-11-02 patch', '2026-11-02 hotfix']);
    assert.deepEqual(data.source, { title: 'WoW: Forever Hotfixes', url: HOTFIX_SRC.url });
    assert.deepEqual(data.sources, [
      { kind: 'hotfix', title: null, url: HOTFIX_SRC.url },
      { kind: 'patch', title: 'Beta build notes', url: PATCH_SRC.url },
    ]);
    assert.ok(lines.includes('Sources: 2/2 ok'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate skips a failing source, keeps its stored days, writes the others', async () => {
  const [dir, out] = await tmpOut();
  try {
    await runUpdate({
      outPath: out, now: fixedNow, log: quiet,
      deps: multiDeps({ [HOTFIX_SRC.url]: [vday('2026-11-01', 'hotfix')], [PATCH_SRC.url]: [vday('2026-09-24', 'patch', 2, 'old patch')] }),
    });
    const lines = [];
    const r = await runUpdate({
      outPath: out, now: fixedNow, log: (m) => lines.push(m),
      deps: multiDeps({ [HOTFIX_SRC.url]: [vday('2026-11-13', 'hotfix')], [PATCH_SRC.url]: new Error('HTTP 503') }),
    });
    assert.equal(r.changed, true);
    const data = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(data.days.map((d) => `${d.date} ${d.kind}`), ['2026-11-13 hotfix', '2026-11-01 hotfix', '2026-09-24 patch']);
    assert.equal(data.days[2].changes[0].text, 'old patch');
    assert.ok(lines.some((l) => /Skipping patch source https:\/\/forum\.test\/t\/1 .*HTTP 503/.test(l)), lines.join('\n'));
    assert.ok(lines.includes('Sources: 1/2 ok'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate treats a source with zero days as failed but still writes the others', async () => {
  const [dir, out] = await tmpOut();
  try {
    const r = await runUpdate({
      outPath: out, now: fixedNow, log: quiet,
      deps: multiDeps({ [HOTFIX_SRC.url]: [], [PATCH_SRC.url]: [vday('2026-11-02', 'patch')] }),
    });
    assert.equal(r.days, 1);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).days.map((d) => d.kind), ['patch']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate refuses to overwrite when every source fails or is empty', async () => {
  const [dir, out] = await tmpOut();
  try {
    await writeFile(out, '{"keep":"me","days":[]}\n');
    await assert.rejects(
      runUpdate({
        outPath: out, now: fixedNow, log: quiet,
        deps: multiDeps({ [HOTFIX_SRC.url]: new Error('Timed out'), [PATCH_SRC.url]: [vday('2026-11-02', 'patch', 0)] }),
      }),
      (err) => {
        assert.match(err.message, /refusing to overwrite/);
        assert.match(err.message, /Timed out/);
        assert.match(err.message, /no days or no changes/);
        return true;
      },
    );
    assert.equal(await readFile(out, 'utf8'), '{"keep":"me","days":[]}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate upgrades stored pre-v2 days to kind "hotfix" with the hotfix link', async () => {
  const [dir, out] = await tmpOut();
  try {
    await writeFile(out, JSON.stringify({ generatedAt: 'x', source: {}, days: [day('2026-10-01')] }));
    await runUpdate({ outPath: out, now: fixedNow, log: quiet, deps: multiDeps({ [PATCH_SRC.url]: [vday('2026-11-02', 'patch')] }) });
    const old = JSON.parse(await readFile(out, 'utf8')).days.find((d) => d.date === '2026-10-01');
    assert.deepEqual(Object.keys(old).slice(0, 4), ['date', 'kind', 'title', 'sourceUrl']);
    assert.deepEqual([old.kind, old.title, old.sourceUrl], ['hotfix', null, HOTFIX_SRC.url]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate loads sources through deps.loadSources with sourcesPath and passes stages through', async () => {
  const [dir, out] = await tmpOut();
  try {
    const seen = {};
    const deps = {
      loadSources: async (path) => { seen.path = path; return [HOTFIX_SRC]; },
      fetchSourceDays: async (source, stages) => { seen.stages = Object.keys(stages).sort(); return [vday('2026-11-13', 'hotfix')]; },
      fetchPost: async () => '', fetchJson: async () => ({}), parseHotfixHtml: () => ({ days: [] }), parsePatchPost: () => ({}),
      addSubjects: async (days) => days,
    };
    await runUpdate({ outPath: out, sourcesPath: '/x/sources.json', deps, now: fixedNow, log: quiet });
    assert.equal(seen.path, '/x/sources.json');
    assert.deepEqual(seen.stages, ['fetchJson', 'fetchPost', 'log', 'parseHotfixHtml', 'parsePatchPost']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v3: tags and the game-data index
// ---------------------------------------------------------------------------

test('runUpdate tags every change, including stored days that no source returns any more', async () => {
  const [dir, out] = await tmpOut();
  try {
    // A stored day from an older run: no tags, not in the fresh data.
    const stored = { date: '2026-10-01', kind: 'hotfix', title: null, sourceUrl: 'https://example.test/post', label: 'x',
      changes: [{ id: '2026-10-01-000', scope: 'class', category: 'Classes', class: 'mage', spec: 'fire', group: null,
        text: 'Fixed an issue with Fireball.', notes: [], subjects: [] }] };
    await writeFile(out, JSON.stringify({ generatedAt: 'x', source: {}, days: [stored] }));
    const deps = stubDeps([day('2026-11-13')]);
    const r = await runUpdate({ outPath: out, deps, now: fixedNow, log: quiet });
    assert.equal(r.changed, true);
    const written = JSON.parse(await readFile(out, 'utf8'));
    const old = written.days.find((d) => d.date === '2026-10-01');
    assert.deepEqual(old.changes[0].tags, ['class:mage', 'spec:mage/fire', 'bugfix']);
    for (const d of written.days) for (const c of d.changes) assert.ok(Array.isArray(c.tags) && c.tags.length > 0);
    // A second identical run changes nothing: tags are deterministic.
    const again = await runUpdate({ outPath: out, deps, now: fixedNow, log: quiet });
    assert.equal(again.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate uses an injected addTags and passes the game index to addSubjects', async () => {
  const [dir, out] = await tmpOut();
  try {
    const index = { lookup: () => null };
    let received;
    const deps = {
      ...stubDeps([day('2026-11-13')]),
      loadGameIndex: async () => index,
      addSubjects: async (days, opts) => { received = opts; return days; },
      addTags: (days) => { days.forEach((d) => d.changes.forEach((c) => { c.tags = ['custom']; })); return days; },
    };
    await runUpdate({ outPath: out, deps, now: fixedNow, log: quiet });
    assert.equal(received.gameIndex, index);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).days[0].changes[0].tags, ['custom']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runUpdate continues with gameIndex null when the index is missing, throws or returns null', async () => {
  for (const loadGameIndex of [undefined, async () => null, async () => { throw new Error('boom'); },
    async () => { throw new Error("Cannot find module './gamedata.mjs'"); }]) {
    const [dir, out] = await tmpOut();
    try {
      let received = 'unset';
      const logs = [];
      const deps = { ...stubDeps([day('2026-11-13')]), loadGameIndex, addSubjects: async (days, opts) => { received = opts.gameIndex; return days; } };
      const r = await runUpdate({ outPath: out, deps, now: fixedNow, log: (m) => logs.push(m) });
      assert.equal(received, null);
      assert.equal(r.changed, true);
      if (loadGameIndex) assert.ok(logs.some((m) => /client data unavailable/.test(m)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
