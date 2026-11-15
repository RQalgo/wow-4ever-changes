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
export const SOURCE_KINDS = new Set(['hotfix', 'patch']);

/** Source types this module knows how to read. */
export const SOURCE_TYPES = new Set(['news-rolling', 'discourse-topic']);

/**
 * Check the shape of a parsed sources list. Throws on the first problem with
 * a message naming the file and the entry, so a typo in the hand-edited file
 * is obvious from the workflow log.
 *
 * @param {unknown} list Parsed JSON.
 * @param {string} [where='sources'] Name used in error messages (file path).
 * @returns {Array<{kind:string,type:string,url:string,title?:string|null}>} `list`, validated.
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

/**
 * Fetch one source and return its days (newest first), each with `kind`,
 * `title` and `sourceUrl` set per docs/SCHEMA.md v2.
 *
 * - news-rolling: fetchPost + parseHotfixHtml; every day gets the source's
 *   kind and URL.
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

  throw new Error(`Unknown source type ${JSON.stringify(source.type)} for ${source.url}`);
}
