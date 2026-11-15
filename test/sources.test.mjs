/**
 * test/sources.test.mjs — unit tests for scripts/sources.mjs.
 *
 * Sources lists are written to temp files; fetchSourceDays gets stub
 * fetchers so nothing touches the network. The Discourse tests use the
 * synthetic topic in test/fixtures/discourse-topic-sample.json with the real
 * parser, so they also check the parser and the post filter together.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSources, validateSources } from '../scripts/sources.mjs';

/**
 * Write `content` to a temp file, run `fn(path)`, then clean up.
 * @param {string} content
 * @param {(path: string) => Promise<void>} fn
 */
async function withFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sources-test-'));
  try {
    const path = join(dir, 'sources.json');
    await writeFile(path, content);
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('loadSources', () => {
  test('the repository\'s data/sources.json is valid', async () => {
    const list = await loadSources(new URL('../data/sources.json', import.meta.url).pathname);
    assert.deepEqual(list.map((s) => [s.kind, s.type]), [['hotfix', 'news-rolling'], ['patch', 'discourse-topic']]);
  });

  test('reads a valid list', async () => {
    const list = [{ kind: 'patch', type: 'discourse-topic', url: 'https://f.test/t/1', title: 'X' }];
    await withFile(JSON.stringify(list), async (path) => {
      assert.deepEqual(await loadSources(path), list);
    });
  });

  test('missing file and invalid JSON give clear errors', async () => {
    await assert.rejects(loadSources('/nonexistent/sources.json'), /Cannot read sources list \/nonexistent\/sources\.json/);
    await withFile('[{', async (path) => {
      await assert.rejects(loadSources(path), /is not valid JSON/);
    });
  });

  test('validateSources names the bad entry and field', () => {
    const ok = { kind: 'hotfix', type: 'news-rolling', url: 'https://n.test/a' };
    assert.throws(() => validateSources({}), /non-empty JSON array/);
    assert.throws(() => validateSources([]), /non-empty JSON array/);
    assert.throws(() => validateSources([ok, 'x'], 'f.json'), /f\.json\[1\]: expected an object/);
    assert.throws(() => validateSources([{ ...ok, kind: 'news' }]), /\[0\]: "kind" must be one of hotfix, patch/);
    assert.throws(() => validateSources([{ ...ok, type: 'rss' }]), /"type" must be one of/);
    assert.throws(() => validateSources([{ ...ok, url: 'not a url' }]), /"url" must be an http\(s\) URL/);
    assert.throws(() => validateSources([{ ...ok, url: 'ftp://n.test/a' }]), /"url" must be an http\(s\) URL/);
    assert.throws(() => validateSources([{ ...ok, title: 5 }]), /"title" must be a string or null/);
    assert.deepEqual(validateSources([{ ...ok, title: null }]), [{ ...ok, title: null }]);
  });
});

describe('pacificDate', () => {
  test('converts UTC timestamps to the US Pacific calendar date', async () => {
    const { pacificDate } = await import('../scripts/sources.mjs');
    assert.equal(pacificDate('2026-11-03T03:20:33Z'), '2026-11-02'); // PST (UTC-8)
    assert.equal(pacificDate('2026-11-03T03:20:33.210Z'), '2026-11-02');
    assert.equal(pacificDate('2026-09-24T22:23:24.849Z'), '2026-09-24');
    assert.equal(pacificDate('2026-07-01T06:59:59Z'), '2026-06-30'); // PDT (UTC-7)
    assert.equal(pacificDate('2026-07-01T07:00:00Z'), '2026-07-01');
    assert.throws(() => pacificDate('nope'), /Invalid timestamp/);
  });
});

describe('fetchSourceDays', async () => {
  const { fetchSourceDays, isPreviousPostNotice, patchNotePosts } = await import('../scripts/sources.mjs');
  const { readFileSync } = await import('node:fs');
  const TOPIC = JSON.parse(readFileSync(new URL('./fixtures/discourse-topic-sample.json', import.meta.url), 'utf8'));
  const PATCH = { kind: 'patch', type: 'discourse-topic', url: 'https://us.forums.blizzard.com/en/wow/t/2360696', title: 'Beta build notes' };
  const quiet = () => {};

  /** Stub fetchJson that records requested URLs and returns `topic`. */
  const jsonStub = (topic) => {
    const urls = [];
    return { urls, fetchJson: async (url) => { urls.push(url); return structuredClone(topic); } };
  };

  test('news-rolling: parses the post and stamps kind and sourceUrl', async () => {
    const urls = [];
    const days = await fetchSourceDays(
      { kind: 'hotfix', type: 'news-rolling', url: 'https://news.test/a' },
      {
        fetchPost: async (url) => { urls.push(url); return '<p><strong>November 13, 2026</strong></p><p><strong>Items</strong></p><ul><li>x</li></ul>'; },
        log: quiet,
      },
    );
    assert.deepEqual(urls, ['https://news.test/a']);
    assert.equal(days.length, 1);
    assert.deepEqual(Object.keys(days[0]), ['date', 'kind', 'title', 'sourceUrl', 'label', 'changes']);
    assert.deepEqual([days[0].date, days[0].kind, days[0].title, days[0].sourceUrl, days[0].label],
      ['2026-11-13', 'hotfix', null, 'https://news.test/a', 'November 13, 2026']);
    assert.equal(days[0].changes[0].id, '2026-11-13-001');
  });

  test('discourse-topic: one day per staff edition, Pacific dates, post links, newest first', async () => {
    const { urls, fetchJson } = jsonStub(TOPIC);
    const days = await fetchSourceDays(PATCH, { fetchJson, log: quiet });
    assert.deepEqual(urls, ['https://us.forums.blizzard.com/en/wow/t/2360696.json']);
    assert.deepEqual(days.map((d) => [d.date, d.kind, d.title, d.sourceUrl, d.label, d.changes.length]), [
      // post 4: created 2026-11-03T03:20Z = November 2 in Pacific time
      ['2026-11-02', 'patch', 'Beta build notes', 'https://us.forums.blizzard.com/en/wow/t/2360696/4', 'November 2, 2026', 3],
      ['2026-09-24', 'patch', 'Beta build notes', 'https://us.forums.blizzard.com/en/wow/t/2360696/1', 'September 24, 2026', 11],
    ]);
    const all = days.flatMap((d) => d.changes.map((c) => c.text));
    assert.ok(!all.some((t) => /Blood Fury/.test(t)), '"previous post" notice skipped');
    assert.ok(!all.some((t) => /wishlist/.test(t)), 'non-staff reply ignored');
  });

  test('patchNotePosts: staff filter, OP fallback, empty and notice posts skipped', () => {
    assert.deepEqual(patchNotePosts(TOPIC.post_stream.posts).map((p) => p.post_number), [1, 4]);
    const posts = [
      { post_number: 3, username: 'Op', staff: false, cooked: '<ul><li>by OP, staff flag missing</li></ul>' },
      { post_number: 1, username: 'Op', staff: true, cooked: '<ul><li>a</li></ul>' },
      { post_number: 2, username: 'Op', staff: true, cooked: '  <p> </p> ' },
      { post_number: 5, username: 'Fan', staff: false, cooked: '<ul><li>c</li></ul>' },
    ];
    assert.deepEqual(patchNotePosts(posts).map((p) => p.post_number), [1, 3]);
  });

  test('isPreviousPostNotice looks only at the start of the post', () => {
    assert.equal(isPreviousPostNotice('<p>We’ve added this section to the previous post.</p>'), true);
    assert.equal(isPreviousPostNotice('<p>We’ve updated the <strong>Previous Post</strong> in this thread.</p><ul><li>x</li></ul>'), true);
    const long = `<p>${'Intro words. '.repeat(30)}</p><ul><li>Fixed the previous post bug.</li></ul>`;
    assert.equal(isPreviousPostNotice(long), false);
  });

  test('editions on the same Pacific date merge into one day with continuous ids', async () => {
    const topic = { id: 1, post_stream: { posts: [
      // 2026-11-03T01:00Z and 2026-11-02T18:00Z are both November 2 in Pacific time.
      { post_number: 6, username: 'B', staff: true, created_at: '2026-11-03T01:00:00Z', cooked: '<p><strong>Items</strong></p><ul><li>second</li></ul>' },
      { post_number: 5, username: 'B', staff: true, created_at: '2026-11-02T18:00:00Z', cooked: '<p><strong>Quests</strong></p><ul><li>first a</li><li>first b</li></ul>' },
    ] } };
    const days = await fetchSourceDays({ ...PATCH, title: undefined }, { fetchJson: jsonStub(topic).fetchJson, log: quiet });
    assert.equal(days.length, 1);
    assert.equal(days[0].title, null);
    assert.equal(days[0].sourceUrl, 'https://us.forums.blizzard.com/en/wow/t/2360696/5', 'first post kept as the link');
    assert.deepEqual(days[0].changes.map((c) => [c.id, c.category, c.text]), [
      ['2026-11-02-p001', 'Quests', 'first a'],
      ['2026-11-02-p002', 'Quests', 'first b'],
      ['2026-11-02-p003', 'Items', 'second'],
    ]);
  });

  test('posts that parse to zero changes are dropped; injected parsePatchPost gets date/title/link', async () => {
    const calls = [];
    const topic = { post_stream: { posts: [{ post_number: 1, username: 'A', staff: true, created_at: '2026-11-03T03:20:33Z', cooked: '<p>Only text.</p>' }] } };
    const days = await fetchSourceDays(PATCH, {
      fetchJson: jsonStub(topic).fetchJson,
      parsePatchPost: (html, opts) => { calls.push(opts); return { date: opts.date, kind: 'patch', title: opts.title, sourceUrl: opts.sourceUrl, label: 'L', changes: [] }; },
      log: quiet,
    });
    assert.deepEqual(days, []);
    assert.deepEqual(calls, [{ date: '2026-11-02', title: 'Beta build notes', sourceUrl: 'https://us.forums.blizzard.com/en/wow/t/2360696/1' }]);
  });

  test('a topic JSON without posts throws; a truncated post stream is logged', async () => {
    await assert.rejects(fetchSourceDays(PATCH, { fetchJson: async () => ({ errors: ['x'] }), log: quiet }), /no post_stream\.posts/);
    const lines = [];
    const topic = { post_stream: { posts: [], stream: [1, 2, 3] } };
    assert.deepEqual(await fetchSourceDays(PATCH, { fetchJson: jsonStub(topic).fetchJson, log: (m) => lines.push(m) }), []);
    assert.match(lines.join('\n'), /has 3 posts but only 0 were included/);
  });

  test('fetch errors propagate; unknown types throw', async () => {
    await assert.rejects(fetchSourceDays(PATCH, { fetchJson: async () => { throw new Error('HTTP 503'); }, log: quiet }), /HTTP 503/);
    await assert.rejects(fetchSourceDays({ ...PATCH, type: 'rss' }, { log: quiet }), /Unknown source type "rss"/);
  });
});
