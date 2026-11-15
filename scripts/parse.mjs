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

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Tags whose content is treated as bold for heading detection. */
const BOLD_TAGS = new Set(['strong', 'b']);

/** Tags that are always headings when they contain text. */
const HEADING_TAGS = new Set(['h3', 'h4']);

/** List container tags. */
const LIST_TAGS = new Set(['ul', 'ol']);

/** Category name (case-insensitive) whose bold sub-headings are classes. */
const CLASSES_CATEGORY = 'classes';

/** Tags allowed in a developer note's <li> (the note is entirely italic). */
const EM_TAGS = new Set(['em', 'i']);

/**
 * Start of a developer note: "Developers’ notes", "Developers' notes",
 * "Developer's note", "Developer notes"... with curly or straight
 * apostrophes, in any case.
 */
const DEV_NOTE_RE = /^developers?['’]?s?['’]?\s+notes?\b/i;

/** Category used for a list that appears after a date but before any category heading. */
const FALLBACK_CATEGORY = 'General';

/**
 * Lower-case tag name of a node, or '' for text/comment nodes.
 * @param {import('node-html-parser').Node} node
 */
function tagOf(node) {
  return node.nodeType === NodeType.ELEMENT_NODE ? (node.rawTagName || '').toLowerCase() : '';
}

/**
 * True for nodes that carry no visible content: comments and
 * whitespace-only text nodes.
 * @param {import('node-html-parser').Node} node
 */
function isBlank(node) {
  if (node.nodeType === NodeType.COMMENT_NODE) return true;
  return node.nodeType === NodeType.TEXT_NODE && cleanText(node.text) === '';
}

/**
 * Visible, decoded, whitespace-collapsed text of a list of nodes. Inline
 * <em>/<strong> contribute their text; <br> contributes a space.
 * @param {import('node-html-parser').Node[]} nodes
 */
function textOf(nodes) {
  return cleanText(nodes.filter((n) => n.nodeType !== NodeType.COMMENT_NODE).map((n) => n.text).join(''));
}

/**
 * True when every non-blank node is an element with one of `tags` and the
 * nodes together have some text, i.e. "the content is entirely bold" (or
 * entirely <em>, for developer notes).
 * @param {import('node-html-parser').Node[]} nodes
 * @param {Set<string>} tags
 */
function isOnly(nodes, tags) {
  const visible = nodes.filter((n) => !isBlank(n));
  return visible.length > 0 && visible.every((n) => tags.has(tagOf(n))) && textOf(visible) !== '';
}

/**
 * If `el` is a heading-like block — <h3>/<h4>, or a <p> whose content is
 * only <strong>/<b> — return its text; otherwise null.
 * @param {import('node-html-parser').HTMLElement} el
 * @returns {string|null}
 */
function headingText(el) {
  const tag = tagOf(el);
  if (HEADING_TAGS.has(tag)) return textOf(el.childNodes) || null;
  if (tag === 'p' && isOnly(el.childNodes, BOLD_TAGS)) return textOf(el.childNodes);
  return null;
}

/**
 * Flatten a DOM subtree, in document order, into heading and list blocks.
 * We do not descend into lists (their inner structure belongs to the list
 * walker) or into headings.
 * @param {import('node-html-parser').Node} node
 * @param {Array<{type:'heading',text:string}|{type:'list',el:import('node-html-parser').HTMLElement}>} [out]
 */
function collectBlocks(node, out = []) {
  for (const child of node.childNodes) {
    const tag = tagOf(child);
    if (!tag) continue;
    if (LIST_TAGS.has(tag)) {
      out.push({ type: 'list', el: child });
      continue;
    }
    const text = headingText(child);
    if (text !== null) {
      out.push({ type: 'heading', text });
      continue;
    }
    // <script>/<style> never contain article markup we can walk as DOM.
    if (tag === 'script' || tag === 'style') continue;
    collectBlocks(child, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// List walker
// ---------------------------------------------------------------------------

/** Block wrappers inside an <li> that are transparent to the list walker. */
const LI_WRAPPER_TAGS = new Set(['p', 'div', 'span']);

/**
 * Split an <li>'s children into its own inline content and its nested lists.
 * @param {import('node-html-parser').HTMLElement} li
 */
function splitListItem(li) {
  const own = [];
  const nested = [];
  // Some CMS output wraps list-item content in a block element
  // ("loose" lists: <li><p><strong>Paladin</strong></p><ul>…</ul></li>).
  // Those wrappers carry no meaning here, so look through them; otherwise
  // "<p><strong>Paladin</strong></p>" would not count as a bold-only heading
  // and a nested list inside the wrapper would be missed.
  const visit = (nodes) => {
    for (const n of nodes) {
      const tag = tagOf(n);
      if (LIST_TAGS.has(tag)) nested.push(n);
      else if (LI_WRAPPER_TAGS.has(tag)) visit(n.childNodes);
      else own.push(n);
    }
  };
  visit(li.childNodes);
  return { own, nested };
}

/**
 * Direct <li> children of a list element.
 * @param {import('node-html-parser').HTMLElement} list
 */
function itemsOf(list) {
  return list.childNodes.filter((n) => tagOf(n) === 'li');
}

/**
 * True when an <li>'s own content is entirely <em>/<i> and starts with a
 * developer-note marker. Such items explain the change before them and are
 * attached to its `notes` instead of becoming a change of their own.
 * @param {import('node-html-parser').Node[]} own The item's non-list children.
 */
export function isDeveloperNote(own) {
  return isOnly(own, EM_TAGS) && DEV_NOTE_RE.test(textOf(own));
}

/**
 * Texts of every item in `lists`, depth-first in published order. Used for
 * the `notes` of a change whose <li> has its own text and a nested list.
 * @param {import('node-html-parser').HTMLElement[]} lists
 * @param {string[]} [out]
 */
function collectNoteTexts(lists, out = []) {
  for (const list of lists) {
    for (const li of itemsOf(list)) {
      const { own, nested } = splitListItem(li);
      const text = textOf(own);
      if (text) out.push(text);
      collectNoteTexts(nested, out);
    }
  }
  return out;
}

/**
 * Build a change object (without its id, assigned per day later).
 * @param {object} ctx Walker context (see walkList).
 * @param {string} text
 */
function makeChange(ctx, text) {
  return {
    id: '',
    scope: ctx.inClasses ? 'class' : 'general',
    category: ctx.category,
    class: ctx.inClasses ? ctx.class : null,
    spec: ctx.inClasses ? ctx.spec : null,
    group: ctx.group.length ? ctx.group.join(' > ') : null,
    text,
    notes: [],
    subjects: [],
  };
}

/**
 * Return the context for the children of a bold heading `<li>`.
 *
 * Inside Classes the first heading level is the class, the second the spec
 * (talent tree); anything deeper, and every heading level in other
 * categories, is appended to `group` (joined later as "A > B").
 * @param {object} ctx
 * @param {string} heading
 */
function descend(ctx, heading) {
  if (ctx.inClasses && ctx.class === null) return { ...ctx, class: slugify(heading) };
  if (ctx.inClasses && ctx.spec === null) return { ...ctx, spec: slugify(heading) };
  return { ...ctx, group: [...ctx.group, heading] };
}

/**
 * Walk one list and append the changes it contains to `out`.
 *
 * @param {import('node-html-parser').HTMLElement} list <ul> or <ol>
 * @param {{category:string,inClasses:boolean,class:string|null,spec:string|null,group:string[]}} ctx
 * @param {object[]} out Changes of the current day, in published order.
 */
function walkList(list, ctx, out) {
  // The last change emitted directly by *this* list; a developer note in a
  // sibling <li> attaches to it. It is not shared with nested or parent
  // lists and is cleared after a heading item, so a note never jumps
  // across a heading.
  let previous = null;
  for (const li of itemsOf(list)) {
    const { own, nested } = splitListItem(li);
    const text = textOf(own);

    // A heading item: only bold text plus a nested list -> class/spec/group.
    // `previous` is reset so a note after the heading's block never jumps
    // back over it to an earlier change; it is kept as a change instead.
    if (nested.length && isOnly(own, BOLD_TAGS)) {
      const inner = descend(ctx, text);
      for (const sub of nested) walkList(sub, inner, out);
      previous = null;
      continue;
    }

    // A wrapper item with no text of its own: just walk its lists.
    if (!text) {
      for (const sub of nested) walkList(sub, ctx, out);
      if (nested.length) previous = null;
      continue;
    }

    // Developer note as a sibling item: attach to the previous change. With
    // no previous change in this list, keep it as a change so the text is
    // never silently dropped.
    if (!nested.length && previous && isDeveloperNote(own)) {
      previous.notes.push(text);
      continue;
    }

    // Ordinary change. (A bold-only item without a nested list also lands
    // here and becomes a change with that text.) If the item has its own
    // text *and* nested lists, the nested items are its notes, e.g. a
    // developer note nested under the change it explains.
    const change = makeChange(ctx, text);
    if (nested.length) change.notes.push(...collectNoteTexts(nested));
    out.push(change);
    previous = change;
  }
}

// ---------------------------------------------------------------------------
// <script> fallback
// ---------------------------------------------------------------------------

/** A month-name date anywhere in a string, e.g. "November 13, 2026". */
const DATE_ANYWHERE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/g;

/** Double-quoted string literal (JSON or JS), body captured, escapes kept. */
const STRING_LITERAL_RE = /"((?:[^"\\\n]|\\.)*)"/g;

/** How deep to look for JSON encoded inside JSON string values. */
const MAX_JSON_DEPTH = 3;

/**
 * Number of month-name dates in `s` if it plausibly holds the article HTML
 * (contains bold markup and at least one date), else 0.
 * @param {string} s
 */
function articleScore(s) {
  if (typeof s !== 'string' || !/<(?:strong|b)\b/i.test(s)) return 0;
  return (s.match(DATE_ANYWHERE_RE) || []).length;
}

/**
 * Push every string found inside a parsed JSON value onto `out`. Strings
 * that themselves look like JSON documents are parsed and searched too (up
 * to MAX_JSON_DEPTH), because frameworks sometimes double-encode payloads.
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 */
function collectJsonStrings(value, out, depth = 0) {
  if (typeof value === 'string') {
    out.push(value);
    const t = value.trim();
    if (depth < MAX_JSON_DEPTH && (t.startsWith('{') || t.startsWith('['))) {
      try { collectJsonStrings(JSON.parse(t), out, depth + 1); } catch { /* not JSON */ }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectJsonStrings(v, out, depth);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectJsonStrings(v, out, depth);
  }
}

/**
 * All string values in a script's source: the whole script parsed as JSON
 * (e.g. `<script id="__NEXT_DATA__" type="application/json">`), plus every
 * double-quoted literal, unescaped with JSON rules, for JS assignments like
 * `window.__STATE__ = {...}` that are not valid JSON as a whole.
 * @param {string} source
 * @returns {string[]}
 */
function scriptStrings(source) {
  const out = [];
  try { collectJsonStrings(JSON.parse(source), out); } catch { /* not pure JSON */ }
  for (const m of source.matchAll(STRING_LITERAL_RE)) {
    // Cheap pre-filter on the still-escaped body before unescaping: "<" may
    // be written as \u003c, so look for the tag name rather than the bracket.
    if (!/strong|\bb\b|u003cb/i.test(m[1])) continue;
    // JS allows \' which JSON does not; normalise it before JSON.parse.
    const body = m[1].replace(/\\'/g, "'");
    try { out.push(JSON.parse(`"${body}"`)); } catch { /* not a JSON-compatible literal */ }
  }
  return out;
}

/**
 * Find candidate article-HTML strings inside the document's <script> tags,
 * best first (most dates, then longest).
 *
 * @param {string|import('node-html-parser').HTMLElement} htmlOrRoot
 * @returns {string[]} Candidate HTML fragments, possibly empty.
 */
export function findArticleHtmlInScripts(htmlOrRoot) {
  const root = typeof htmlOrRoot === 'string' ? parseDom(htmlOrRoot, { comment: false }) : htmlOrRoot;
  const scored = [];
  const seen = new Set();
  for (const script of root.querySelectorAll('script')) {
    for (const str of scriptStrings(script.rawText)) {
      const score = articleScore(str);
      if (score > 0 && !seen.has(str)) {
        seen.add(str);
        scored.push({ str, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || b.str.length - a.str.length);
  return scored.map((c) => c.str);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Find every date heading element in document order (same recognition rules
 * as collectBlocks: not inside lists, scripts or styles).
 * @param {import('node-html-parser').Node} node
 * @param {import('node-html-parser').HTMLElement[]} [out]
 */
function findDateHeadings(node, out = []) {
  for (const child of node.childNodes) {
    const tag = tagOf(child);
    if (!tag || LIST_TAGS.has(tag) || tag === 'script' || tag === 'style') continue;
    const text = headingText(child);
    if (text !== null) {
      if (parseDateLabel(text)) out.push(child);
      continue;
    }
    findDateHeadings(child, out);
  }
  return out;
}

/**
 * The smallest element that contains every date heading as a descendant:
 * the parent of the date headings when they are siblings (the real page),
 * or their lowest common ancestor when each day sits in its own wrapper.
 * Returns `root` itself when there are no date headings.
 * @param {import('node-html-parser').HTMLElement} root
 */
function articleContainer(root) {
  const headings = findDateHeadings(root);
  if (headings.length === 0) return root;
  // Chain of ancestors of a node, outermost first.
  const chain = (n) => {
    const c = [];
    for (let p = n.parentNode; p; p = p.parentNode) c.unshift(p);
    return c;
  };
  let common = chain(headings[0]);
  for (const h of headings.slice(1)) {
    const c = chain(h);
    let i = 0;
    while (i < common.length && i < c.length && common[i] === c[i]) i++;
    common = common.slice(0, i);
  }
  // A date heading may sit alone in its own wrapper with the lists in a
  // sibling wrapper. Climb until the container really holds a list, so the
  // changes are never cut off from their date.
  let i = common.length - 1;
  while (i > 0 && !common[i].querySelector('ul, ol')) i--;
  return common[i] ?? root;
}

/**
 * Parse an HTML document or fragment into days of changes.
 * @param {import('node-html-parser').HTMLElement} root
 * @returns {Array<{date:string,label:string,changes:object[]}>} Days in document order.
 */
function parseDays(root) {
  const days = new Map(); // ISO date -> day; a repeated date merges into one day
  let day = null;
  let category = null;

  // Only walk the element that actually holds the article body. Without this,
  // lists that follow the article in the page (related links, the site
  // footer's navigation) would be read as changes of the oldest day.
  for (const block of collectBlocks(articleContainer(root))) {
    if (block.type === 'heading') {
      const iso = parseDateLabel(block.text);
      if (iso) {
        if (!days.has(iso)) days.set(iso, { date: iso, label: block.text, changes: [] });
        day = days.get(iso);
        category = null;
      } else if (day) {
        category = block.text;
      }
      // Headings before the first date (e.g. intro text) are ignored.
      continue;
    }
    if (!day) continue; // lists before the first date are not hotfixes
    const cat = category ?? FALLBACK_CATEGORY;
    const inClasses = cat.toLowerCase() === CLASSES_CATEGORY;
    walkList(block.el, { category: cat, inClasses, class: null, spec: null, group: [] }, day.changes);
  }
  return [...days.values()];
}

/**
 * Sort days newest first and assign ids "<date>-<NNN>" (1-based, 3 digits)
 * in published order within each day.
 * @param {Array<{date:string,changes:object[]}>} days
 */
function finalizeDays(days) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const d of sorted) {
    d.changes.forEach((c, i) => { c.id = `${d.date}-${String(i + 1).padStart(3, '0')}`; });
  }
  return sorted;
}

/**
 * Parse the hotfix post HTML into `{ days }` as defined in docs/SCHEMA.md
 * (without the top-level generatedAt/source, which the pipeline adds).
 *
 * @param {string} html Full page HTML or just the article fragment.
 * @returns {{days: Array<{date:string,label:string,changes:object[]}>}}
 */
export function parseHotfixHtml(html) {
  const root = parseDom(String(html ?? ''), { comment: false });
  let days = parseDays(root);
  if (days.length === 0) {
    // No date headings in the DOM: the article may only exist as data in a
    // <script> (client-side rendering). Use the first candidate that parses.
    for (const fragment of findArticleHtmlInScripts(root)) {
      days = parseDays(parseDom(fragment, { comment: false }));
      if (days.length) break;
    }
  }
  return { days: finalizeDays(days) };
}
