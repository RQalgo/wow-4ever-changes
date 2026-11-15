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

/**
 * Split an <li>'s children into its own inline content and its nested lists.
 * @param {import('node-html-parser').HTMLElement} li
 */
function splitListItem(li) {
  const own = [];
  const nested = [];
  for (const n of li.childNodes) (LIST_TAGS.has(tagOf(n)) ? nested : own).push(n);
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
  for (const li of itemsOf(list)) {
    const { own, nested } = splitListItem(li);
    const text = textOf(own);

    // A heading item: only bold text plus a nested list -> class/spec/group.
    if (nested.length && isOnly(own, BOLD_TAGS)) {
      const inner = descend(ctx, text);
      for (const sub of nested) walkList(sub, inner, out);
      continue;
    }

    // A wrapper item with no text of its own: just walk its lists.
    if (!text) {
      for (const sub of nested) walkList(sub, ctx, out);
      continue;
    }

    // Ordinary leaf: one change. (A bold-only item without a nested list
    // also lands here and becomes a change with that text.)
    out.push(makeChange(ctx, text));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse an HTML document or fragment into days of changes.
 * @param {import('node-html-parser').HTMLElement} root
 * @returns {Array<{date:string,label:string,changes:object[]}>} Days in document order.
 */
function parseDays(root) {
  const days = new Map(); // ISO date -> day; a repeated date merges into one day
  let day = null;
  let category = null;

  for (const block of collectBlocks(root)) {
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
  return { days: finalizeDays(parseDays(root)) };
}
