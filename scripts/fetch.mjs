/**
 * scripts/fetch.mjs — download Blizzard's rolling "WoW: Forever Hotfixes" post.
 *
 * Step 1 of the pipeline described in docs/PLAN.md. It does one thing: fetch
 * the article page and return its HTML as a string for scripts/parse.mjs.
 *
 * Design notes:
 * - The `fetch` implementation is injectable (`fetchImpl`) so tests can stub
 *   the network completely; the sandbox and CI never need to reach Blizzard.
 * - We identify ourselves honestly with a project User-Agent that links back
 *   to the repository. We deliberately do not impersonate a browser.
 * - Redirects are followed (Blizzard's news site may redirect between locale
 *   paths), a hard 30 second timeout bounds the request, and any non-2xx
 *   response becomes an Error whose message says which URL and status failed,
 *   so a failing scheduled run is easy to diagnose from its log.
 */

/** Canonical URL of the rolling hotfix post. */
export const SOURCE_URL = 'https://news.blizzard.com/en-us/article/24315281';

/** Honest User-Agent sent with every request. */
export const USER_AGENT = 'wow-4ever-changes/0.1 (+https://github.com/RQalgo/wow-4ever-changes)';

/** Default request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fetch the hotfix post and return its HTML.
 *
 * @param {string} [url=SOURCE_URL] Page to download.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch] fetch implementation; tests
 *   pass a stub here.
 * @param {number} [options.timeoutMs=30000] Abort the request after this many
 *   milliseconds.
 * @returns {Promise<string>} The response body as text.
 * @throws {Error} On network failure, timeout, or a non-2xx HTTP status.
 */
export async function fetchPost(url = SOURCE_URL, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError";
    // translate it into a message that names the URL and the limit.
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`Timed out after ${timeoutMs} ms fetching ${url}`, { cause: err });
    }
    throw new Error(`Network error fetching ${url}: ${err?.message ?? err}`, { cause: err });
  }

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}${statusText}`);
  }
  return await response.text();
}
