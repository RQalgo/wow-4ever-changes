/**
 * scripts/parse.mjs — turn the "WoW: Forever Hotfixes" post HTML into the
 * `{ days: [...] }` structure defined in docs/SCHEMA.md.
 *
 * Step 2 of the pipeline (docs/PLAN.md). The icon resolver later fills each
 * change's `subjects`; this module always emits `subjects: []`.
 *
 * Shape of the source body (see test/fixtures/hotfixes-sample.html):
 *
 *   <hr>
 *   <p><strong>November 13, 2026</strong></p>   date heading
 *   <p><strong>Classes</strong></p>             category heading
 *   <ul> ... nested lists ... </ul>             the category's changes
 *   <p><strong>Items</strong></p><ul>...</ul>
 *
 * Design:
 * - We never rely on wrapper class names (only the rendered DOM was available
 *   when this was written). Instead the whole document is flattened, in
 *   document order, into a sequence of "blocks": heading-like elements
 *   (`<p>` whose content is only bold, `<h3>`, `<h4>`) and top-level lists.
 *   A heading whose text is a date starts a new day; any other heading after
 *   a date is a category; a list is walked under the current day/category.
 * - If the DOM has no date headings at all (e.g. the article is rendered
 *   client-side), we look inside `<script>` tags for a string value that holds
 *   the article HTML, JSON-unescape it, and parse that fragment instead.
 * - Each pure helper is exported so it can be unit-tested on its own.
 */
import { parse as parseDom, NodeType } from 'node-html-parser';

/** Month names (full and common abbreviations) to 1-based month numbers. */
const MONTHS = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['jun', 6], ['jul', 7], ['aug', 8],
  ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

/**
 * Matches a whole date label such as "November 13, 2026". Tolerates an
 * abbreviated month ("Nov."), an ordinal suffix ("13th") and a missing comma.
 */
const DATE_LABEL_RE = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/;

/**
 * Collapse runs of whitespace (including non-breaking spaces and newlines)
 * into single spaces and trim the ends.
 *
 * @param {string} s
 * @returns {string}
 */
export function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Lower-case slug used for class and spec ids: "Beast Mastery" ->
 * "beast-mastery". Curly and straight apostrophes are dropped (so "Bob's"
 * becomes "bobs"), any other run of non-alphanumerics becomes one "-".
 *
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return cleanText(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents left over by NFKD
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse a published date heading into an ISO date.
 *
 * @param {string} label e.g. "November 13, 2026"
 * @returns {string|null} "2026-11-13", or null if the label is not a valid date.
 */
export function parseDateLabel(label) {
  const m = DATE_LABEL_RE.exec(cleanText(label));
  if (!m) return null;
  const month = MONTHS.get(m[1].toLowerCase());
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month) return null;
  // Reject impossible days such as "February 30" by round-tripping via UTC.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
