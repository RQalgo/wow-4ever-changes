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
    assert.deepEqual(list.map((s) => [s.kind, s.type]), [['hotfix', 'news-rolling'], ['patch', 'discourse-topic'], ['dev', 'discourse-tracker']]);
    assert.deepEqual(list[2], {
      kind: 'dev', type: 'discourse-tracker', url: 'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json',
      categoryId: 347, title: 'Dev Posts',
    });
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

describe('discourse-tracker (fixtures: tracker-page1/2.json, tracker-post-*.json)', async () => {
  const { fetchSourceDays, forumBase, trackerPageUrl, defaultTrackerCutoff, devChangeId, validateSources: validate } = await import('../scripts/sources.mjs');
  const { readFileSync } = await import('node:fs');
  const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  const FEED = 'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json';
  const DEV = { kind: 'dev', type: 'discourse-tracker', url: FEED, categoryId: 347, title: 'Dev Posts' };
  const FORUM = 'https://us.forums.blizzard.com/en/wow';
  const XP_URL = `${FORUM}/t/player-level-dungeon-xp-adjustment-november-14/2416343/1`;

  /**
   * Stub fetchJson over the fixtures: page 1, page 2 (before_post_id=30850001),
   * then empty pages; post bodies by id. `pages` may replace the feed pages
   * (keyed by before_post_id, '' = first page); `failBodies` ids throw.
   */
  const stub = ({ pages, failBodies = [] } = {}) => {
    const urls = [];
    const feed = pages ?? { '': fx('tracker-page1.json'), 30850001: fx('tracker-page2.json') };
    const fetchJson = async (url) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/posts.json')) {
        const page = feed[u.searchParams.get('before_post_id') ?? ''];
        if (page instanceof Error) throw page;
        return structuredClone(page ?? { posts: [] });
      }
      const id = /\/posts\/(\d+)\.json$/.exec(u.pathname)?.[1];
      if (failBodies.includes(id)) throw new Error('HTTP 429');
      return fx(`tracker-post-${id}.json`);
    };
    return { urls, fetchJson };
  };
  const run = (deps = {}, s = stub()) => fetchSourceDays(DEV, { fetchJson: s.fetchJson, delayMs: 0, log: () => {}, ...deps });

  test('helpers: forum base, page URLs, ids, default cutoff', () => {
    assert.equal(forumBase(FEED), FORUM);
    assert.throws(() => forumBase('https://x.test/en/wow/t/1.json'), /group feed URL/);
    assert.equal(trackerPageUrl(FEED), FEED);
    assert.equal(trackerPageUrl(FEED, 30850001), `${FEED}?before_post_id=30850001`);
    assert.equal(devChangeId('2026-11-14', 0), '2026-11-14-d001');
    assert.equal(defaultTrackerCutoff([]), '2026-09-01');
    assert.equal(defaultTrackerCutoff(undefined), '2026-09-01');
    assert.equal(defaultTrackerCutoff([{ date: '2026-11-02' }, { date: '2026-09-24' }, { date: '2026-10-01' }]), '2026-09-24');
  });

  test('validateSources: a tracker needs a positive integer categoryId; kind "dev" is known', () => {
    assert.deepEqual(validate([DEV]), [DEV]);
    assert.throws(() => validate([{ ...DEV, categoryId: '347' }]), /"categoryId" must be a positive integer/);
    assert.throws(() => validate([{ ...DEV, categoryId: undefined }]), /"categoryId"/);
    assert.throws(() => validate([{ ...DEV, categoryId: [] }]), /"categoryId"/);
    assert.throws(() => validate([{ ...DEV, categoryId: [347, 0] }]), /"categoryId"/);
    assert.deepEqual(validate([{ ...DEV, categoryId: [347, 40] }])[0].categoryId, [347, 40]);
  });

  test('two pages via before_post_id, category 347 only (352 and 40 dropped), bodies for every new post', async () => {
    const s = stub();
    const days = await run({}, s);
    assert.deepEqual(s.urls, [
      FEED,
      `${FEED}?before_post_id=30850001`, // the last post of page 1
      `${FEED}?before_post_id=30650001`, // the last post of page 2 -> empty page: end of the feed
      `${FORUM}/posts/30700001.json`, `${FORUM}/posts/30850001.json`, `${FORUM}/posts/30912982.json`,
    ]);
    const all = days.flatMap((d) => d.changes);
    assert.equal(all.length, 3);
    assert.ok(!all.some((c) => /Hotfixes - November 13|Raid Encounter Design/.test(c.text)), 'categories 352 and 40 dropped');
  });

  test('days: Pacific dates, newest first, v4 envelope; changes: text, url, author, postNumber, d-ids', async () => {
    const days = await run();
    assert.deepEqual(days.map((d) => [d.date, d.kind, d.title, d.sourceUrl, d.label]), [
      ['2026-11-14', 'dev', null, null, 'November 14, 2026'], // created 2026-11-15T01:18Z
      ['2026-11-10', 'dev', null, null, 'November 10, 2026'],
      ['2026-10-07', 'dev', null, null, 'October 7, 2026'],
    ]);
    const [xp] = days[0].changes;
    assert.deepEqual(Object.keys(xp), ['id', 'scope', 'category', 'class', 'spec', 'group', 'text', 'notes',
      'url', 'author', 'authorTitle', 'postNumber', 'subjects', '_fullText']);
    assert.deepEqual([xp.id, xp.scope, xp.category, xp.class, xp.spec, xp.group, xp.text, xp.url, xp.author, xp.authorTitle, xp.postNumber],
      ['2026-11-14-d001', 'general', 'Dev Posts', null, null, null, 'Player-Level Dungeon XP Adjustment - November 14',
        XP_URL, 'Kaivax', 'Community Manager', 1]);
    const [reply] = days[1].changes;
    assert.equal(reply.text, 'Reply in “PvP Faction Balance Updates - November 10”');
    assert.equal(reply.postNumber, 174);
    assert.deepEqual(reply.notes, ['To clarify, the restriction applies only to the more populous faction on PvP rulesets, including Roleplay-PvP. Battleground queues are not affected.']);
    assert.ok(!reply._fullText.includes('RP-PvP realms?'), 'the quoted player is not part of the full text');
    const [deep] = days[2].changes;
    assert.equal(deep.authorTitle, null, 'an empty user_title is null');
    assert.equal(deep.author, 'BlizzardEntertainment');
    assert.ok(deep._fullText.includes('Maelstrom Weapon'), 'the full body, not just the summary');
    assert.ok(!deep.notes.join(' ').includes('Maelstrom Weapon'));
    for (const c of days.flatMap((d) => d.changes)) assert.ok(c.notes.join('').length <= 400);
  });

  test('categoryId as an array keeps several categories from one feed', async () => {
    const days = await fetchSourceDays({ ...DEV, categoryId: [347, 40] }, { fetchJson: stub().fetchJson, delayMs: 0, log: () => {} });
    const texts = days.flatMap((d) => d.changes.map((c) => c.text));
    assert.equal(texts.length, 4);
    assert.ok(texts.includes('Raid Encounter Design in Season 3'));
  });

  test('stop rule: a page whose oldest post is older than the cutoff ends the paging; older posts dropped', async () => {
    const s = stub();
    const days = await run({ cutoffDate: '2026-10-05' }, s);
    // Page 2's oldest post (Oct 1) is older than Oct 5: no third page request.
    assert.equal(s.urls.filter((u) => u.includes('/posts.json')).length, 2);
    assert.deepEqual(days.map((d) => d.date), ['2026-11-14', '2026-11-10', '2026-10-07']);
    const later = await run({ cutoffDate: '2026-10-08' });
    assert.deepEqual(later.map((d) => d.date), ['2026-11-14', '2026-11-10'], 'Oct 7 is before the cutoff');
  });

  test('default cutoff: the oldest stored day (any kind), else 2026-09-01', async () => {
    const s = stub();
    const days = await run({ storedDays: [{ date: '2026-11-01', kind: 'hotfix', changes: [] }] }, s);
    // Page 1 ends on Nov 10 (not older than Nov 1), page 2 on Oct 1 (older): stop after 2.
    assert.equal(s.urls.filter((u) => u.includes('/posts.json')).length, 2);
    assert.deepEqual(days.map((d) => d.date), ['2026-11-14', '2026-11-10']);
  });

  test('stop rule: the safety cap of pages (logged)', async () => {
    const lines = [];
    let n = 0;
    const endless = async (url) => {
      if (!url.includes('/posts.json')) return { cooked: '<p>x</p>' };
      n += 1;
      return { posts: [{ id: 1000 - n, created_at: '2026-11-14T20:00:00Z', category_id: 1, url: `/t/x/${n}/1`, post_number: 1 }] };
    };
    await fetchSourceDays(DEV, { fetchJson: endless, delayMs: 0, maxPages: 3, log: (m) => lines.push(m) });
    assert.equal(n, 3);
    assert.match(lines.join('\n'), /safety cap of 3 pages/);
    const defaults = await import('../scripts/sources.mjs');
    assert.equal(defaults.MAX_TRACKER_PAGES, 30);
  });

  test('pauses between every request (500 ms by default)', async () => {
    const pauses = [];
    const s = stub();
    await fetchSourceDays(DEV, { fetchJson: s.fetchJson, sleep: async (ms) => { pauses.push(ms); }, log: () => {} });
    assert.equal(pauses.length, s.urls.length - 1);
    assert.ok(pauses.every((ms) => ms === 500));
  });

  test('a body that cannot be fetched falls back to the feed excerpt (one log line); the source does not fail', async () => {
    const lines = [];
    const days = await run({ log: (m) => lines.push(m) }, stub({ failBodies: ['30912982'] }));
    const xp = days[0].changes[0];
    assert.deepEqual(xp.notes, ['Yesterday, we updated dungeon play so that experience granted by an enemy in an']);
    assert.equal(xp._fullText, 'Player-Level Dungeon XP Adjustment - November 14\nYesterday, we updated dungeon play so that experience granted by an enemy in an');
    assert.equal(lines.filter((l) => /post 30912982 unavailable \(HTTP 429\)/.test(l)).length, 1);
    assert.equal(days.flatMap((d) => d.changes).length, 3);
  });

  test('the first page failing fails the source; a later page failing ends the paging', async () => {
    await assert.rejects(run({}, stub({ pages: { '': new Error('HTTP 503') } })), /posts\.json: HTTP 503/);
    const lines = [];
    const days = await run({ log: (m) => lines.push(m) }, stub({ pages: { '': fx('tracker-page1.json'), 30850001: new Error('HTTP 503') } }));
    assert.deepEqual(days.map((d) => d.date), ['2026-11-14', '2026-11-10']);
    assert.match(lines.join('\n'), /page 2 failed \(HTTP 503\)/);
  });

  test('a stored post (same url) is reused as stored: no body request, same id, subjects and tags', async () => {
    const stored = {
      id: '2026-11-14-d001', scope: 'general', category: 'Dev Posts', class: null, spec: null, group: null,
      text: 'Player-Level Dungeon XP Adjustment - November 14', notes: ['stored summary'], url: XP_URL,
      author: 'Kaivax', authorTitle: 'Community Manager', postNumber: 1,
      subjects: [{ name: 'Deadmines', type: 'spell', icon: 'x' }], tags: ['dungeons'],
    };
    const gone = { ...stored, id: '2026-11-14-d002', url: `${FORUM}/t/older/1/5`, text: 'Reply in “Older”', postNumber: 5 };
    const storedDays = [{ date: '2026-11-14', kind: 'dev', title: null, sourceUrl: null, label: 'November 14, 2026', changes: [stored, gone] }];
    const before = structuredClone(storedDays);
    // A second post of Nov 14 that is new on the feed.
    const page1 = fx('tracker-page1.json');
    page1.posts.unshift({ ...page1.posts[0], id: 30920000, created_at: '2026-11-15T05:00:00Z', post_number: 2,
      url: '/t/player-level-dungeon-xp-adjustment-november-14/2416343/2' });
    const s = stub({ pages: { '': page1, 30850001: fx('tracker-page2.json') }, failBodies: ['30920000'] });
    const days = await run({ storedDays, cutoffDate: '2026-09-01' }, s);
    assert.ok(!s.urls.includes(`${FORUM}/posts/30912982.json`), 'stored post not re-fetched');
    const nov14 = days.find((d) => d.date === '2026-11-14');
    assert.deepEqual(nov14.changes.map((c) => [c.id, c.url.split('/').pop(), c.notes[0].slice(0, 14)]), [
      ['2026-11-14-d001', '1', 'stored summary'], // reused unchanged
      ['2026-11-14-d002', '5', 'stored summary'], // fell off the feed: kept
      ['2026-11-14-d003', '2', 'Yesterday, we '], // new: the next free number
    ]);
    assert.deepEqual(nov14.changes[0], stored);
    assert.deepEqual(storedDays, before, 'stored days are not mutated');
  });

  test('new posts of one day are numbered oldest first', async () => {
    const page = { posts: [
      { id: 3, created_at: '2026-11-14T22:00:00Z', category_id: 347, url: '/t/b/2/1', post_number: 1, topic_title: 'Later', excerpt: 'b' },
      { id: 2, created_at: '2026-11-14T18:00:00Z', category_id: 347, url: '/t/a/1/1', post_number: 1, topic_title: 'Earlier', excerpt: 'a' },
    ] };
    const days = await run({ cutoffDate: '2026-11-01' }, stub({ pages: { '': page }, failBodies: ['2', '3'] }));
    assert.deepEqual(days[0].changes.map((c) => [c.id, c.text]), [['2026-11-14-d001', 'Earlier'], ['2026-11-14-d002', 'Later']]);
  });
});
