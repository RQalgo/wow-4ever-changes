/**
 * test/fetch.test.mjs — unit tests for scripts/fetch.mjs.
 *
 * The network is never touched: every test passes a stub `fetchImpl` that
 * records the request and returns a canned Response (or never resolves, to
 * exercise the timeout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPost, metaRefreshTarget, SOURCE_URL, USER_AGENT } from '../scripts/fetch.mjs';

/**
 * Build a stub fetch that records its calls and returns `response`.
 * @param {Response} response
 */
function stubFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

test('fetchPost returns the body and sends the honest User-Agent', async () => {
  const { impl, calls } = stubFetch(new Response('<html>ok</html>', { status: 200 }));
  const html = await fetchPost(undefined, { fetchImpl: impl });
  assert.equal(html, '<html>ok</html>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SOURCE_URL);
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.equal(USER_AGENT, 'wow-4ever-changes/0.1 (+https://github.com/RQalgo/wow-4ever-changes)');
  assert.equal(calls[0].init.redirect, 'follow');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('fetchPost uses the URL it is given', async () => {
  const { impl, calls } = stubFetch(new Response('x', { status: 200 }));
  await fetchPost('https://example.test/post', { fetchImpl: impl });
  assert.equal(calls[0].url, 'https://example.test/post');
});

test('fetchPost throws a clear error on non-2xx', async () => {
  const { impl } = stubFetch(new Response('nope', { status: 503, statusText: 'Service Unavailable' }));
  await assert.rejects(fetchPost(SOURCE_URL, { fetchImpl: impl }), (err) => {
    assert.match(err.message, /HTTP 503 Service Unavailable/);
    assert.ok(err.message.includes(SOURCE_URL));
    return true;
  });
});

test('fetchPost wraps network errors', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fetchPost(SOURCE_URL, { fetchImpl: impl }), /Network error fetching .*fetch failed/);
});

test('fetchPost times out', async () => {
  // A stub that only settles when the abort signal fires, like real fetch.
  // AbortSignal.timeout() uses an unref'd timer, so a ref'd keep-alive timer
  // stops the event loop from draining before the abort fires.
  const impl = (url, init) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5_000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason);
    });
  });
  await assert.rejects(fetchPost(SOURCE_URL, { fetchImpl: impl, timeoutMs: 20 }), /Timed out after 20 ms/);
});

// --- In-body (meta refresh) redirects, as served by Blizzard's news site ----

test('metaRefreshTarget resolves a relative same-site target and rejects other hosts', () => {
  const base = 'https://news.example.test/en-us/article/1';
  assert.equal(
    metaRefreshTarget('<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/en-us/article/1/slug"/>', base),
    'https://news.example.test/en-us/article/1/slug',
  );
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="0;url=https://evil.test/x">', base), null);
  assert.equal(metaRefreshTarget('<p>no redirect here</p>', base), null);
});

test('fetchPost follows a 307 whose target is only in a meta refresh tag', async () => {
  const urls = [];
  const impl = async (url) => {
    urls.push(String(url));
    if (!String(url).endsWith('/slug')) {
      return new Response('<html id="__next_error__"><meta http-equiv="refresh" content="1;url=/en-us/article/1/slug"/></html>', { status: 307 });
    }
    return new Response('<p>article</p>', { status: 200 });
  };
  const body = await fetchPost('https://news.example.test/en-us/article/1', { fetchImpl: impl });
  assert.equal(body, '<p>article</p>');
  assert.deepEqual(urls, ['https://news.example.test/en-us/article/1', 'https://news.example.test/en-us/article/1/slug']);
});

test('fetchPost gives up on an endless chain of in-page redirects', async () => {
  let n = 0;
  const impl = async () => new Response(`<meta http-equiv="refresh" content="1;url=/hop${++n}">`, { status: 307 });
  await assert.rejects(fetchPost('https://news.example.test/a', { fetchImpl: impl }), /too many in-page redirects/);
});
