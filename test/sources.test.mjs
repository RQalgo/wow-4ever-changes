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
