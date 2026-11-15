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
  // Blizzard's news site (a Next.js app) answers the short article URL with a
  // redirect to the full URL including the title slug. That redirect is not
  // sent as a Location header: the response is "307" with an HTML body holding
  // <meta http-equiv="refresh" content="1;url=/en-us/article/<id>/<slug>">.
  // The slug changes whenever the post is retitled with a new date, so it
  // cannot be hard-coded; we follow the in-body redirect like a browser does.
  let current = url;
  for (let hop = 0; ; hop++) {
    const { response, body } = await requestOnce(current, { fetchImpl, timeoutMs });
    const target = metaRefreshTarget(body, current);
    const isRedirectStatus = response.status >= 300 && response.status < 400;
    if (target && target !== current && (isRedirectStatus || !response.ok || body.includes('__next-page-redirect'))) {
      if (hop >= MAX_META_REDIRECTS) {
        throw new Error(`Failed to fetch ${url}: too many in-page redirects (last: ${target})`);
      }
      current = target;
      continue;
    }
    if (!response.ok) throw httpError(current, response, body);
    return body;
  }
}

/** Maximum number of in-body (meta refresh) redirects followed per fetch. */
export const MAX_META_REDIRECTS = 3;

/**
 * Extract the target of an HTML meta-refresh redirect, resolved against the
 * page URL. Only same-site http(s) targets are returned, so a page can never
 * send the fetcher to a different host.
 *
 * @param {string} html Response body.
 * @param {string} baseUrl URL the body was fetched from.
 * @returns {string|null} Absolute target URL, or null when there is none.
 */
export function metaRefreshTarget(html, baseUrl) {
  // Match <meta … http-equiv="refresh" … content="<seconds>;url=<target>" …>
  // with the two attributes in either order.
  const tag = /<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*>/i.exec(html ?? '');
  const content = tag && /content=["']\s*\d*\s*;\s*url=([^"']+)["']/i.exec(tag[0]);
  // Next.js can also describe the redirect only inside its serialised error
  // payload, as the digest "NEXT_REDIRECT;<replace|push>;<url>;<status>;".
  const digest = /NEXT_REDIRECT;(?:replace|push);([^;"\\<\s]+);30\d;/.exec(html ?? '');
  const raw = content?.[1] ?? digest?.[1];
  if (!raw) return null;
  try {
    const target = new URL(raw.trim().replace(/&amp;/g, '&'), baseUrl);
    const base = new URL(baseUrl);
    if (!/^https?:$/.test(target.protocol) || target.host !== base.host) return null;
    return target.href;
  } catch {
    return null; // malformed URL in the tag
  }
}

/**
 * Build the Error for a failed response, including the headers that explain
 * why (redirect target, answering server) and the start of the body, so a
 * failing scheduled run can be diagnosed from its log alone.
 *
 * @param {string} url URL that failed.
 * @param {Response} response The non-2xx response.
 * @param {string} body Its body text (may be empty).
 * @returns {Error}
 */
function httpError(url, response, body) {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const h = (name) => response.headers?.get?.(name);
  const details = ['location', 'server', 'content-type', 'cf-mitigated', 'retry-after']
    .filter((name) => h(name))
    .map((name) => `${name}=${h(name)}`)
    .join('; ');
  let snippet = (body ?? '').replace(/\s+/g, ' ').slice(0, 200);
  // For redirect answers, also show the text around any redirect hint in the
  // body, since that is where this site puts the target.
  const hint = /.{0,80}(?:NEXT_REDIRECT|http-equiv|url=).{0,160}/i.exec(body ?? '');
  if (hint) snippet += ` … hint: ${hint[0].replace(/\s+/g, ' ')}`;
  return new Error(
    `Failed to fetch ${url}: HTTP ${response.status}${statusText}` +
      (details ? ` [${details}]` : '') +
      (snippet ? ` body: ${snippet}` : ''),
  );
}

/**
 * Perform one HTTP request and read its body, translating network failures
 * and timeouts into clear Errors. Does not judge the HTTP status.
 *
 * @param {string} url
 * @param {{fetchImpl: typeof fetch, timeoutMs: number}} options
 * @returns {Promise<{response: Response, body: string}>}
 */
async function requestOnce(url, { fetchImpl, timeoutMs }) {
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

  let body = '';
  try {
    body = await response.text();
  } catch {
    // Body unavailable (e.g. connection dropped); status is still reported.
  }
  return { response, body };
}
