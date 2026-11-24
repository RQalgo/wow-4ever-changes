/**
 * scripts/sources.mjs — the list of data sources and how to turn each one
 * into days of changes (docs/SCHEMA.md, "Version 2").
 *
 * `data/sources.json` is a hand-edited array; each entry says what kind of
 * day it produces ("hotfix" | "patch") and how to read it:
 *
 *   - type "news-rolling":    Blizzard's rolling news post with date headings
 *                             inside the page (the WoW: Forever Hotfixes post).
 *   - type "discourse-topic": a Blizzard forum topic; each staff post is one
 *                             edition of patch notes, dated by its creation
 *                             time in US Pacific time.
 *   - type "discourse-tracker": the forum's Blizzard tracker (a feed of every
 *                             staff post, newest first), filtered to one
 *                             forum category; each post becomes one change
 *                             of a `kind: "dev"` day (docs/SCHEMA.md v4,
 *                             see fetchTrackerDays).
 *
 * The orchestrator (scripts/update.mjs) calls `loadSources` once and
 * `fetchSourceDays` per source. The network and parser functions are passed
 * in (`deps`), so tests can run every branch with stubs; missing deps are
 * loaded lazily from scripts/fetch.mjs and scripts/parse.mjs.
 *
 * A Discourse post is a patch-notes edition when it is by staff, not empty,
 * and not a short "We've updated the previous post…" notice (those repeat
 * content already in the post before them).
 */
import { readFile } from 'node:fs/promises';

/** Day kinds a source may produce. */
export const SOURCE_KINDS = new Set(['hotfix', 'patch', 'dev']);

/** Source types this module knows how to read. */
export const SOURCE_TYPES = new Set(['news-rolling', 'discourse-topic', 'discourse-tracker']);

/**
 * Check the shape of a parsed sources list. Throws on the first problem with
 * a message naming the file and the entry, so a typo in the hand-edited file
 * is obvious from the workflow log.
 *
 * @param {unknown} list Parsed JSON.
 * @param {string} [where='sources'] Name used in error messages (file path).
 * A "discourse-tracker" entry also needs `categoryId`: the forum category
 * whose posts are kept, a positive integer, or a non-empty array of them to
 * keep several categories (one feed, read once). It may also carry
 * `excludeTopicTitle`, a case-insensitive regular expression: posts in a
 * topic whose title matches are skipped.
 *
 * @returns {Array<{kind:string,type:string,url:string,title?:string|null,categoryId?:number|number[],excludeTopicTitle?:string}>} `list`, validated.
 * @throws {Error} when the list or an entry is malformed.
 */
export function validateSources(list, where = 'sources') {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${where}: expected a non-empty JSON array of sources`);
  }
  list.forEach((s, i) => {
    const at = `${where}[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at}: expected an object`);
    if (!SOURCE_KINDS.has(s.kind)) throw new Error(`${at}: "kind" must be one of ${[...SOURCE_KINDS].join(', ')} (got ${JSON.stringify(s.kind)})`);
    if (!SOURCE_TYPES.has(s.type)) throw new Error(`${at}: "type" must be one of ${[...SOURCE_TYPES].join(', ')} (got ${JSON.stringify(s.type)})`);
    let ok = false;
    try { ok = typeof s.url === 'string' && /^https?:$/.test(new URL(s.url).protocol); } catch { /* not a URL */ }
    if (!ok) throw new Error(`${at}: "url" must be an http(s) URL (got ${JSON.stringify(s.url)})`);
    if (s.title !== undefined && s.title !== null && typeof s.title !== 'string') {
      throw new Error(`${at}: "title" must be a string or null`);
    }
    if (s.type === 'discourse-tracker') {
      const ids = Array.isArray(s.categoryId) ? s.categoryId : [s.categoryId];
      if (!ids.length || !ids.every((id) => Number.isInteger(id) && id > 0)) {
        throw new Error(`${at}: "categoryId" must be a positive integer or an array of them for a discourse-tracker source (got ${JSON.stringify(s.categoryId)})`);
      }
      // Optional: a regular expression (case-insensitive) for topic titles to
      // skip, e.g. the forum mirror of the hotfix news post, whose replies
      // repeat what the hotfix source already shows.
      if (s.excludeTopicTitle !== undefined) {
        let compiles = false;
        try { compiles = typeof s.excludeTopicTitle === 'string' && s.excludeTopicTitle !== '' && !!new RegExp(s.excludeTopicTitle, 'i'); } catch { /* invalid pattern */ }
        if (!compiles) throw new Error(`${at}: "excludeTopicTitle" must be a non-empty regular expression string (got ${JSON.stringify(s.excludeTopicTitle)})`);
      }
    }
  });
  return list;
}

/**
 * Read and validate the sources list.
 *
 * @param {string} [path='data/sources.json'] File to read.
 * @returns {Promise<Array<{kind:string,type:string,url:string,title?:string|null}>>}
 * @throws {Error} if the file is missing, not JSON, or malformed. Unlike a
 *   corrupt changes.json this is fatal: without sources there is nothing to do.
 */
export async function loadSources(path = 'data/sources.json') {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read sources list ${path}: ${err.message}`, { cause: err });
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (err) {
    throw new Error(`Sources list ${path} is not valid JSON: ${err.message}`, { cause: err });
  }
  return validateSources(list, path);
}

/** Formats a Date as its calendar date in US Pacific time (handles DST). */
const PACIFIC_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * Calendar date of an instant in US Pacific time, which is how Blizzard
 * dates its posts: a post made at 2026-11-03T03:20:33Z is "November 2".
 *
 * @param {string} isoString An ISO timestamp, e.g. Discourse's `created_at`.
 * @returns {string} "YYYY-MM-DD"
 * @throws {Error} if the timestamp cannot be parsed.
 */
export function pacificDate(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${isoString}`);
  // formatToParts avoids depending on the locale's separator/order.
  const parts = Object.fromEntries(PACIFIC_DATE.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * A forum post that only announces an edit to the post before it ("We’ve
 * updated the previous post in this thread with some additions…", "We’ve
 * added this section to the previous post."). Its content duplicates the
 * edited post, so it is skipped. Matched near the start of the post's text.
 */
const PREVIOUS_POST_NOTICE_RE = /previous post/i;

/** How much of a post's leading text is searched for the notice. */
const NOTICE_WINDOW = 200;

/**
 * Plain text of a post's HTML, good enough for the notice check: tags
 * removed, a few common entities decoded, whitespace collapsed.
 * @param {string} html
 * @returns {string}
 */
function roughText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a post's text starts (within the first NOTICE_WINDOW characters)
 * with a "previous post" edit notice.
 * @param {string} cooked Post HTML.
 * @returns {boolean}
 */
export function isPreviousPostNotice(cooked) {
  return PREVIOUS_POST_NOTICE_RE.test(roughText(cooked).slice(0, NOTICE_WINDOW));
}

/**
 * Posts of a Discourse topic that hold patch notes: written by staff (or by
 * the topic's author, in case the staff flag is missing), not empty, and not
 * a "previous post" edit notice. Sorted by post number.
 *
 * @param {Array<object>} posts `post_stream.posts` of the topic JSON.
 * @returns {Array<object>}
 */
export function patchNotePosts(posts) {
  const opUser = posts.find((p) => p.post_number === 1)?.username;
  return posts
    .filter((p) => p.staff === true || (opUser !== undefined && p.username === opUser))
    .filter((p) => roughText(p.cooked) !== '')
    .filter((p) => !isPreviousPostNotice(p.cooked))
    .sort((a, b) => a.post_number - b.post_number);
}

// ---------------------------------------------------------------------------
// discourse-tracker: staff posts from the Blizzard tracker (schema v4)
// ---------------------------------------------------------------------------

/** Cutoff date used when nothing is stored yet (before WoW: Forever's first notes). */
export const DEFAULT_TRACKER_CUTOFF = '2026-09-01';

/** Safety cap on tracker pages read per run (20 posts each). */
export const MAX_TRACKER_PAGES = 30;

/** Pause between two tracker requests (feed pages and post bodies), in ms. */
export const TRACKER_DELAY_MS = 500;

/**
 * Id of the i-th (0-based) change of a dev-post day: "<date>-dNNN", 1-based,
 * 3 digits (docs/SCHEMA.md v4).
 *
 * @param {string} date ISO date.
 * @param {number} index 0-based position within the day.
 * @returns {string} e.g. "2026-11-14-d001"
 */
export function devChangeId(date, index) {
  return `${date}-d${String(index + 1).padStart(3, '0')}`;
}

/**
 * Base URL of the forum a tracker feed belongs to: everything before
 * "/groups/" ("https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json"
 * -> "https://us.forums.blizzard.com/en/wow"). Post links (`post.url`, which
 * start with "/t/…") and post bodies ("/posts/<id>.json") hang off it.
 *
 * @param {string} feedUrl The source's `url`.
 * @returns {string}
 * @throws {Error} if the URL has no "/groups/" segment.
 */
export function forumBase(feedUrl) {
  const u = new URL(feedUrl);
  const i = u.pathname.indexOf('/groups/');
  if (i < 0) throw new Error(`Not a Discourse group feed URL (expected …/groups/<name>/posts.json): ${feedUrl}`);
  return `${u.origin}${u.pathname.slice(0, i)}`;
}

/**
 * URL of one tracker page: the feed itself, or older posts with
 * `?before_post_id=<id>` (the id of the last post of the previous page).
 *
 * @param {string} feedUrl
 * @param {number|null} beforePostId
 * @returns {string}
 */
export function trackerPageUrl(feedUrl, beforePostId = null) {
  const u = new URL(feedUrl);
  if (beforePostId !== null && beforePostId !== undefined) u.searchParams.set('before_post_id', String(beforePostId));
  return u.href;
}

/**
 * Default cutoff for tracker paging: the oldest date of any stored day (all
 * kinds; the site shows nothing older), or DEFAULT_TRACKER_CUTOFF when
 * nothing is stored.
 *
 * @param {Array<{date?: string}>|undefined} storedDays
 * @returns {string} "YYYY-MM-DD"
 */
export function defaultTrackerCutoff(storedDays) {
  // Review change: page back only a week past the NEWEST stored dev day.
  // Older dev posts are already stored and kept by the merge, so reading back
  // to the oldest stored date of any kind (the earlier rule) cost up to 30
  // pages every run and, on the first run, cut off posts older than the
  // oldest hotfix/patch day. A staff reply in an old thread has a recent
  // created_at, so the margin still catches it. No dev days yet → the
  // all-time default.
  const dates = (storedDays ?? [])
    .filter((d) => d?.kind === 'dev')
    .map((d) => d.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''));
  if (!dates.length) return DEFAULT_TRACKER_CUTOFF;
  const newest = dates.reduce((a, b) => (b > a ? b : a));
  const t = new Date(`${newest}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - TRACKER_CUTOFF_MARGIN_DAYS);
  return t.toISOString().slice(0, 10);
}

/** Days before the newest stored dev day that each run still re-reads. */
export const TRACKER_CUTOFF_MARGIN_DAYS = 7;

/**
 * Pacific date of a post, or null when its `created_at` is unusable (such a
 * post is skipped rather than failing the source).
 * @param {{created_at?: string}} post
 * @returns {string|null}
 */
function postDate(post) {
  try { return pacificDate(post.created_at); } catch { return null; }
}

/**
 * Build the change for one tracker post (docs/SCHEMA.md v4), without its id.
 * `text` is the topic title, or `Reply in “<title>”` for a staff reply
 * (post_number > 1). `notes` is the summary from `parsed`; `_fullText` is
 * TRANSIENT: title + whole body as plain text, read by scripts/icons.mjs and
 * scripts/tags.mjs and deleted by scripts/update.mjs before writing.
 *
 * @param {object} post A tracker feed post.
 * @param {{notes: string[], fullText: string}} parsed parseDevPost's result.
 * @param {string} base forumBase of the source.
 * @returns {object}
 */
export function devPostChange(post, parsed, base) {
  const title = String(post.topic_title ?? '').replace(/\s+/g, ' ').trim();
  const postNumber = Number.isInteger(post.post_number) ? post.post_number : 1;
  return {
    id: '',
    scope: 'general',
    category: 'Dev Posts',
    class: null,
    spec: null,
    group: null,
    text: postNumber > 1 ? `Reply in “${title}”` : title,
    notes: parsed.notes,
    url: `${base}${post.url}`,
    author: post.name || post.username || null,
    authorTitle: post.user_title || null,
    postNumber,
    subjects: [],
    _fullText: parsed.fullText,
  };
}

/**
 * Read a Blizzard tracker feed (`discourse-tracker` source) into dev-post
 * days, newest first. Steps:
 *
 * 1. PAGING. Fetch the feed, then older pages with `?before_post_id=<id of
 *    the last post on the page>`, pausing `delayMs` before every request
 *    after the first. Stop when
 *      - a page is empty (the end of the feed), or
 *      - the page's OLDEST post (smallest Pacific date) is older than
 *        `cutoffDate`: everything after it is older still, or
 *      - `maxPages` pages were read (safety cap; logged).
 *    The first page failing fails the source (its stored days are kept by
 *    the merge); a later page failing just ends the paging (logged).
 * 2. FILTER. Keep posts whose `category_id` is `source.categoryId` (or one
 *    of them, when it is an array), whose topic title does not match
 *    `source.excludeTopicTitle` (when set), a regular
 *    post type (1, or missing), a readable date on or after the cutoff; drop
 *    duplicates (same id on two pages).
 * 3. CHANGES. A post whose link (`url`) is already stored in a dev day is
 *    REUSED as stored (same id, notes, subjects and tags; no body request).
 *    Any other post's body is fetched from `<forum>/posts/<id>.json`
 *    (`cooked`) and read with parseDevPost; if that fails, the feed's excerpt
 *    is used instead (one log line), never failing the source.
 * 4. DAYS. Posts are grouped by the Pacific date of `created_at`. A day also
 *    keeps its stored changes that are no longer on the feed. New changes
 *    get the next free numbers of their day in feed order oldest -> newest,
 *    so ids never change once given.
 *
 * @param {{kind:string,url:string,categoryId:number|number[],excludeTopicTitle?:string}} source
 * @param {object} opts
 * @param {Function} opts.fetchJson (url) => Promise<unknown>
 * @param {Function} opts.parseDevPost (html, {title}) => {notes, fullText}
 * @param {Function} opts.excerptText (excerpt) => string
 * @param {Function} opts.cutAtWord (text, max) => string
 * @param {Function} opts.formatDateLabel (iso) => label
 * @param {number} [opts.summaryMax=400] Longest excerpt-fallback summary.
 * @param {object[]} [opts.storedDays=[]] Days already in data/changes.json.
 * @param {string} [opts.cutoffDate] ISO date; default defaultTrackerCutoff(storedDays).
 * @param {number} [opts.maxPages=MAX_TRACKER_PAGES]
 * @param {number} [opts.delayMs=TRACKER_DELAY_MS]
 * @param {(ms: number) => Promise<void>} [opts.sleep] Injectable pause.
 * @param {(msg: string) => void} opts.log
 * @returns {Promise<object[]>} Days with kind = source.kind, newest first.
 * @throws {Error} when the first page cannot be read.
 */
export async function fetchTrackerDays(source, opts) {
  const { fetchJson, log } = opts;
  const storedDays = opts.storedDays ?? [];
  const cutoff = opts.cutoffDate ?? defaultTrackerCutoff(storedDays);
  const maxPages = opts.maxPages ?? MAX_TRACKER_PAGES;
  const delayMs = opts.delayMs ?? TRACKER_DELAY_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = forumBase(source.url);

  // Every request after the first waits delayMs (politeness, see README).
  let requests = 0;
  const politeFetch = async (url) => {
    if (requests++ > 0 && delayMs > 0) await sleep(delayMs);
    return fetchJson(url);
  };

  // 1. Paging. `pages` counts pages read; `stop` says why paging ended.
  const feed = [];
  let before = null;
  let pages = 0;
  let stop = 'cap';
  while (pages < maxPages) {
    const url = trackerPageUrl(source.url, before);
    let list;
    try {
      list = (await politeFetch(url))?.posts;
      if (!Array.isArray(list)) throw new Error('no "posts" array in the feed JSON');
    } catch (err) {
      if (pages === 0) throw new Error(`${url}: ${err.message}`, { cause: err });
      log(`tracker: page ${pages + 1} failed (${err.message}); using the ${pages} page(s) read`);
      stop = 'error';
      break;
    }
    pages++;
    // Stop rule 1: an empty page is the end of the feed.
    if (list.length === 0) { stop = 'end'; break; }
    feed.push(...list);
    // Stop rule 2: the page's OLDEST post is older than the cutoff, so every
    // later page is older still. The smallest date is used rather than
    // trusting the newest-first order.
    const dates = list.map(postDate).filter(Boolean);
    const oldest = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null;
    if (oldest !== null && oldest < cutoff) { stop = 'cutoff'; break; }
    // Next page: posts before the LAST post of this page (Discourse's cursor).
    before = list[list.length - 1]?.id;
    if (!Number.isInteger(before)) { stop = 'end'; break; }
  }
  // Stop rule 3: the safety cap (a feed that never gets older than the cutoff).
  if (stop === 'cap') log(`tracker: stopped after the safety cap of ${maxPages} pages (cutoff ${cutoff} not reached)`);

  // 2. Filter: the category (or categories), regular posts, inside the
  //    window, no repeats.
  const categories = new Set(Array.isArray(source.categoryId) ? source.categoryId : [source.categoryId]);
  // Topics to skip by title (source.excludeTopicTitle), e.g. "^WoW: Forever
  // Hotfixes": Blizzard mirrors the hotfix news post in the Bug Report forum
  // and replies to that thread with each update, which the hotfix source
  // already covers.
  const excludeTitle = source.excludeTopicTitle ? new RegExp(source.excludeTopicTitle, 'i') : null;
  let excluded = 0;
  const seen = new Set();
  const posts = [];
  for (const post of feed) {
    if (!categories.has(post?.category_id)) continue;
    if (excludeTitle && excludeTitle.test(String(post.topic_title ?? ''))) { excluded++; continue; }
    if (post.post_type !== undefined && post.post_type !== 1) continue; // small actions, whispers
    const date = postDate(post);
    if (!date || date < cutoff || typeof post.url !== 'string' || seen.has(post.id)) continue;
    seen.add(post.id);
    posts.push({ post, date });
  }
  // Oldest first (feed order reversed), so new ids follow publication order.
  posts.sort((a, b) => String(a.post.created_at).localeCompare(String(b.post.created_at)) || a.post.id - b.post.id);

  // Stored dev-post changes, by link, and stored dev days, by date.
  const storedByUrl = new Map();
  const storedByDate = new Map();
  for (const day of storedDays) {
    if (day?.kind !== 'dev') continue;
    storedByDate.set(day.date, day);
    for (const change of day.changes ?? []) if (change?.url) storedByUrl.set(change.url, change);
  }

  // 3. + 4. Changes, grouped into days.
  const byDate = new Map(); // date -> { changes: [], urls: Set }
  const dayFor = (date) => {
    if (!byDate.has(date)) {
      // Start from the stored day's changes (deep copies: the stored data is
      // not mutated), so posts that fell off the feed stay in their day.
      const stored = (storedByDate.get(date)?.changes ?? []).map((c) => structuredClone(c));
      byDate.set(date, { changes: stored, urls: new Set(stored.map((c) => c.url)) });
    }
    return byDate.get(date);
  };
  let fetched = 0;
  let reused = 0;
  let fallbacks = 0;
  for (const { post, date } of posts) {
    const day = dayFor(date);
    const url = `${base}${post.url}`;
    if (day.urls.has(url)) { reused++; continue; } // stored in this day already
    if (storedByUrl.has(url)) {
      // Stored under another date (should not happen; created_at is fixed):
      // keep the stored change as it is, in its own day.
      reused++;
      continue;
    }
    let parsed;
    try {
      const body = await politeFetch(`${base}/posts/${post.id}.json`);
      if (typeof body?.cooked !== 'string') throw new Error('no "cooked" HTML in the post JSON');
      parsed = opts.parseDevPost(body.cooked, { title: post.topic_title });
      fetched++;
    } catch (err) {
      // Fallback: the feed's (cut) excerpt as the summary and the full text.
      const excerpt = opts.excerptText(post.excerpt);
      parsed = {
        notes: excerpt ? [opts.cutAtWord(excerpt, opts.summaryMax ?? 400)] : [],
        fullText: [post.topic_title, excerpt].filter(Boolean).join('\n'),
      };
      fallbacks++;
      log(`tracker: body of post ${post.id} unavailable (${err.message}); using the feed excerpt`);
    }
    const change = devPostChange(post, parsed, base);
    // Next free number of the day: one more than the highest stored id.
    const used = day.changes.map((c) => Number(/-d(\d+)$/.exec(c.id ?? '')?.[1] ?? 0));
    change.id = devChangeId(date, Math.max(0, ...used));
    day.changes.push(change);
    day.urls.add(url);
  }
  log(`tracker: ${pages} page(s), ${posts.length} post(s) in category ${[...categories].join('/')} since ${cutoff}: `
    + `${fetched} new, ${reused} already stored, ${fallbacks} from the excerpt`
    + (excluded ? `; ${excluded} skipped by excludeTopicTitle` : ''));

  const idNumber = (c) => Number(/-d(\d+)$/.exec(c.id ?? '')?.[1] ?? 0);
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, { changes }]) => ({
      date,
      kind: source.kind,
      title: null,
      sourceUrl: null,
      label: opts.formatDateLabel(date),
      changes: changes.sort((a, b) => idNumber(a) - idNumber(b)),
    }));
}

/**
 * Fetch one source and return its days (newest first), each with `kind`,
 * `title` and `sourceUrl` set per docs/SCHEMA.md v2.
 *
 * - news-rolling: fetchPost + parseHotfixHtml; every day gets the source's
 *   kind and URL.
 * - discourse-tracker: see fetchTrackerDays (dev-post days, schema v4).
 * - discourse-topic: fetchJson of the topic's .json; each patch-note post
 *   (see patchNotePosts) becomes one day via parsePatchPost, dated by its
 *   `created_at` in US Pacific time and linked as `<source.url>/<post_number>`.
 *   Posts with no changes are dropped; posts on the same Pacific date are
 *   merged into one day (changes appended in post order, ids renumbered,
 *   the first post's link kept).
 *
 * @param {{kind:string,type:string,url:string,title?:string|null}} source One validated entry.
 * @param {object} [deps] Injectable stages; missing ones are imported lazily.
 * @param {Function} [deps.fetchPost]       (url) => Promise<string>
 * @param {Function} [deps.fetchJson]       (url) => Promise<unknown>
 * @param {Function} [deps.parseHotfixHtml] (html) => { days }
 * @param {Function} [deps.parsePatchPost]  (html, { date, title, sourceUrl }) => day
 * @param {Function} [deps.parseDevPost]    (html, { title }) => { notes, fullText }
 * @param {object[]} [deps.storedDays]  previously stored days (discourse-tracker:
 *   reuse of stored posts and the default cutoff; ignored by the other types)
 * @param {string} [deps.cutoffDate]    discourse-tracker: ISO date to page back to
 * @param {number} [deps.maxPages]      discourse-tracker: page cap (30)
 * @param {number} [deps.delayMs]       discourse-tracker: pause between requests (500)
 * @param {(ms: number) => Promise<void>} [deps.sleep] discourse-tracker: injectable pause
 * @param {(msg: string) => void} [deps.log=console.error]
 * @returns {Promise<object[]>} Days, possibly empty.
 * @throws {Error} on fetch errors, an unknown type, or a topic without posts.
 */
export async function fetchSourceDays(source, deps = {}) {
  const log = deps.log ?? console.error;
  // Imported lazily so loadSources/validateSources work without the other
  // stages; the pure helpers (discourseJsonUrl, patchChangeId) always come
  // from the real modules, the stages may be stubbed.
  const [fetchMod, parseMod] = await Promise.all([import('./fetch.mjs'), import('./parse.mjs')]);
  const fetchPost = deps.fetchPost ?? fetchMod.fetchPost;
  const fetchJson = deps.fetchJson ?? fetchMod.fetchJson;
  const parseHotfixHtml = deps.parseHotfixHtml ?? parseMod.parseHotfixHtml;
  const parsePatchPost = deps.parsePatchPost ?? parseMod.parsePatchPost;

  if (source.type === 'news-rolling') {
    const html = await fetchPost(source.url);
    const days = parseHotfixHtml(html)?.days ?? [];
    // Rebuild each day so the v2 fields come in schema order.
    return days.map((d) => ({
      date: d.date,
      kind: source.kind,
      title: source.title ?? d.title ?? null,
      sourceUrl: source.url,
      label: d.label,
      changes: d.changes,
    }));
  }

  if (source.type === 'discourse-topic') {
    const jsonUrl = fetchMod.discourseJsonUrl(source.url);
    const topic = await fetchJson(jsonUrl);
    const posts = topic?.post_stream?.posts;
    if (!Array.isArray(posts)) throw new Error(`${jsonUrl}: no post_stream.posts in the topic JSON`);
    // Discourse includes only the first ~20 posts inline; the full id list is
    // post_stream.stream. Warn so a long topic is noticed (see docs/PLAN.md).
    const streamLength = topic.post_stream.stream?.length ?? posts.length;
    if (streamLength > posts.length) {
      log(`${jsonUrl}: topic has ${streamLength} posts but only ${posts.length} were included; later posts are not read`);
    }
    const topicUrl = source.url.replace(/\/+$/, '');
    const byDate = new Map(); // Pacific ISO date -> merged day
    for (const post of patchNotePosts(posts)) {
      const day = parsePatchPost(post.cooked, {
        date: pacificDate(post.created_at),
        title: source.title ?? null,
        sourceUrl: `${topicUrl}/${post.post_number}`,
      });
      if (!day.changes.length) continue; // nothing we could read in this post
      const same = byDate.get(day.date);
      if (!same) {
        byDate.set(day.date, { ...day, kind: source.kind });
        continue;
      }
      // Two editions on one Pacific date: one day, ids continuous.
      same.changes.push(...day.changes);
      same.changes.forEach((c, i) => { c.id = parseMod.patchChangeId(same.date, i); });
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  if (source.type === 'discourse-tracker') {
    return fetchTrackerDays(source, {
      fetchJson,
      parseDevPost: deps.parseDevPost ?? parseMod.parseDevPost,
      excerptText: parseMod.excerptText,
      cutAtWord: parseMod.cutAtWord,
      formatDateLabel: parseMod.formatDateLabel,
      summaryMax: parseMod.DEV_SUMMARY_MAX,
      storedDays: deps.storedDays,
      cutoffDate: deps.cutoffDate,
      maxPages: deps.maxPages,
      delayMs: deps.delayMs,
      sleep: deps.sleep,
      log,
    });
  }

  throw new Error(`Unknown source type ${JSON.stringify(source.type)} for ${source.url}`);
}
