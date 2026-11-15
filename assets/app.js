/**
 * app.js - entry point (ES module) for "WoW: Forever - Changes at a Glance".
 *
 * Responsibilities:
 *   - load ./data/changes.json and show loading / error / empty states
 *   - own the UI state (class, spec, query, category chips, kind) and re-render
 *   - build every DOM node with createElement/textContent (data is never
 *     inserted through innerHTML)
 *
 * Pure logic (filtering, search, suggestions, hash encoding) lives in
 * ./logic.js so it can be unit tested without a DOM.
 *
 * Days are identified by date + kind (see dayKey in logic.js): a patch and a
 * hotfix can share a date.
 *
 * Sections: helpers, data loading, rendering, boot.
 */

import {
  CLASSES, flattenSections, relativeDay, classColor, defaultState, visibleDays,
  specsForClass, titleCase, className, iconUrl, glyphKey, queryTerms,
  highlightSegments, buildSuggestions, iconSlots, extraTagsForLine, encodeHash, decodeHash, sanitizeSelection,
  dayKind, dayKey, KIND_FILTERS, sanitizeKindFilter,
  availableCategories, toggleCategory, normalizeCats, isCategoryOn,
  activeFilterCount, filterSummary, hasPanelFlag, withPanelFlag,
} from './logic.js';

/** Current UI state: class, spec, search text, enabled categories (null = all), kind filter. */
let state = defaultState();

/** The loaded dataset (see docs/SCHEMA.md), or null before loading. */
let data = null;

/** Category chips offered for the loaded data (only tags that occur in it). */
let categories = [];

/** Shortcut for document.getElementById. */
const $ = (id) => document.getElementById(id);

/**
 * Create an element with optional class and text content.
 * @param {string} tag
 * @param {string} [cls] space separated class names
 * @param {string} [text] assigned via textContent (safe for any data)
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Fetch and minimally validate the data file. The relative URL works both on
 * GitHub Pages (/wow-4ever-changes/) and when served locally.
 * @returns {Promise<object>} parsed changes.json
 * @throws {Error} on network, HTTP or shape problems
 */
async function loadData() {
  const res = await fetch('./data/changes.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.days)) throw new Error('Unexpected data format');
  return json;
}

/**
 * Replace the results area with a status message (loading / error).
 * @param {string} title short heading
 * @param {string} detail explanatory sentence
 * @param {{label: string, onClick: Function}} [action] optional button
 * @param {boolean} [isError] marks the box with role="alert"
 */
function showStatus(title, detail, action, isError) {
  const box = el('div', 'status' + (isError ? ' status-error' : ''));
  if (isError) box.setAttribute('role', 'alert');
  box.append(el('strong', null, title), el('p', null, detail));
  if (action) {
    const b = el('button', 'btn', action.label);
    b.type = 'button';
    b.addEventListener('click', action.onClick);
    box.append(b);
  }
  $('results').replaceChildren(box);
}

/** Fill the header with "last updated" and the official source link. */
function renderHeader() {
  const when = data.generatedAt ? new Date(data.generatedAt) : null;
  $('updated').textContent = when && !isNaN(when)
    ? `Last updated ${when.toISOString().slice(0, 10)}`
    : 'Last updated: unknown';
  const url = data.source && data.source.url;
  // Only allow http(s) links, in case the data file is ever malformed.
  if (url && /^https?:\/\//i.test(url)) $('source-link').href = url;
}

/** Lower-case query words for the current state; used to highlight matches. */
let terms = [];

/**
 * Build a fragment of text nodes and <mark> elements for `text`, marking the
 * current search words. Pure DOM nodes, so the data is always escaped.
 * @param {string} text
 * @returns {DocumentFragment}
 */
function highlighted(text) {
  const frag = document.createDocumentFragment();
  for (const seg of highlightSegments(text, terms)) {
    if (seg.match) frag.append(el('mark', null, seg.text));
    else frag.append(document.createTextNode(seg.text));
  }
  return frag;
}

/** SVG path data (24x24 viewBox, stroke only) for the original fallback glyphs. */
const GLYPHS = {
  spark: 'M12 2.5 14.3 9.7 21.5 12 14.3 14.3 12 21.5 9.7 14.3 2.5 12 9.7 9.7Z',
  gem: 'M6 4h12l4 6-10 11L2 10Z M2 10h20 M9 4l-2 6 5 11 5-11-2-6',
  scroll: 'M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M12 8v5 M12 16v.5',
  arch: 'M4 21V11a8 8 0 0 1 16 0v10 M9 21v-7a3 3 0 0 1 6 0v7 M3 21h18',
  hex: 'M12 2.5 20 7v10l-8 4.5L4 17V7Z M12 8v8 M8 10v4 M16 10v4',
};

/**
 * Build the inline SVG fallback glyph for a change.
 * @param {object} ch change (scope/category decide the glyph)
 * @param {number} [size] pixel size of the glyph
 * @returns {SVGElement}
 */
function glyphSvg(ch, size = 22) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', GLYPHS[glyphKey(ch)]);
  svg.append(path);
  return svg;
}

/**
 * Build one icon tile of the cluster. The tile has a fixed CSS size (set by
 * the cluster class), so an image loading or failing never shifts the layout.
 * A subject with a usable icon shows its Wowhead image (lazy); anything else,
 * including an image that fails to load, becomes the glyph tile. Talents get
 * the `tile-talent` class (a corner pip) and "(talent)" in the title, so the
 * kind never relies on the mark or colour alone.
 * @param {object} ch the change (decides glyph and fallback colour)
 * @param {{name: string, icon?: string, talent: boolean, title: string}|null} slot subject slot, or null for the "no subjects" tile
 * @param {object|null} subject raw subject (for its class colour)
 * @param {number} glyphPx glyph size used by the fallback
 * @returns {HTMLElement}
 */
function renderTile(ch, slot, subject, glyphPx) {
  const tile = el('div', 'tile');
  tile.style.setProperty('--cc', classColor((subject && subject.class) || ch.class) || 'var(--muted)');
  if (slot) {
    tile.title = slot.title;
    if (slot.talent) { tile.classList.add('tile-talent'); tile.dataset.kind = 'talent'; }
  }
  const url = slot ? iconUrl(slot.icon) : null;

  /** Swap whatever is in the tile for the glyph. */
  const useFallback = () => {
    tile.classList.add('tile-fallback');
    tile.classList.toggle('tile-class', ch.scope !== 'general' && !!ch.class);
    // Keep the pip (a ::after) but replace the image with the glyph.
    tile.replaceChildren(glyphSvg(ch, glyphPx));
  };

  if (!url) { useFallback(); return tile; }
  const img = new Image(32, 32);
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = slot.title;
  img.addEventListener('error', useFallback, { once: true });
  img.src = url;
  tile.append(img);
  return tile;
}

/**
 * Build the icon cluster of a line: up to MAX_ICONS subject icons in subject
 * order. One icon is a single 32px tile; 2-4 icons are small tiles in a
 * 2-wide grid (a row for two, 2x2 for three or four). The cluster box has a
 * fixed width, so text lines up from line to line. A line without subjects
 * gets one fallback tile (class or category glyph).
 * @param {object} ch change
 * @returns {HTMLElement}
 */
function renderIcons(ch) {
  const { slots } = iconSlots(ch);
  const subjects = (ch.subjects || []).filter((x) => x && x.name);
  const box = el('div', `icons icons-${Math.max(1, slots.length)}`);
  if (!slots.length) {
    box.append(renderTile(ch, null, null, 20));
    return box;
  }
  const glyphPx = slots.length === 1 ? 20 : 13;
  slots.forEach((slot, i) => box.append(renderTile(ch, slot, subjects[i], glyphPx)));
  return box;
}

/**
 * Build one "extra tag" chip under a line. Class chips (class colour dot +
 * name) set the class filter, category chips show only that category; the
 * Talent chip is informational. Real <button>s, so they are keyboard
 * accessible.
 * @param {object} tag from extraTagsForLine
 * @returns {HTMLElement}
 */
function renderTagChip(tag) {
  if (tag.type === 'talent') {
    const t = el('span', 'subject-chip tag-chip tag-talent');
    t.append(el('span', 'talent-pip'), 'Talent');
    t.title = 'Involves a talent';
    return t;
  }
  const b = el('button', 'subject-chip tag-chip ' + (tag.type === 'class' ? 'tag-class' : 'tag-cat'));
  b.type = 'button';
  if (tag.type === 'class') {
    b.style.setProperty('--cc', tag.color || 'var(--muted)');
    b.append(el('span', 'chip-dot'), tag.label);
    b.title = `Show only ${tag.label} changes`;
    b.addEventListener('click', () => setState({ ...state, cls: tag.slug, spec: '' }));
  } else {
    b.textContent = tag.label;
    b.title = `Show only ${tag.label}`;
    b.addEventListener('click', () => setState({ ...state, cats: [tag.slug] }));
  }
  return b;
}

/**
 * Render one change line: icon cluster, text, extra tag chips (other classes,
 * Talent, other categories), overflow subject chips and notes. The line is
 * drawn once, in its published section; the chips say what else it touches.
 * @param {object} ch a change from the data
 * @returns {HTMLElement} <li>
 */
function renderLine(ch) {
  const li = el('li', 'line');
  const body = el('div', 'line-body');
  const text = el('p', 'line-text');
  // Class-scope lines can carry a sub-heading (e.g. "Cooldown Manager" under
  // Classes). General lines already show their group as a section heading,
  // so the inline label is only added for class lines.
  if (ch.scope === 'class' && ch.group) {
    const label = el('span', 'line-group');
    label.append(highlighted(ch.group));
    text.append(label, ' ');
  }
  text.append(highlighted(ch.text));
  body.append(text);
  const tags = extraTagsForLine(ch).map(renderTagChip);
  // Subjects beyond the icon cluster stay as search chips.
  const more = iconSlots(ch).more.map((sub) => {
    const b = el('button', 'subject-chip');
    b.type = 'button';
    b.title = `Search for ${sub.name}`;
    b.append(highlighted(sub.name));
    b.addEventListener('click', () => { setState({ ...state, q: sub.name }); });
    return b;
  });
  if (tags.length || more.length) {
    const chips = el('div', 'subject-chips');
    chips.append(...tags, ...more);
    body.append(chips);
  }
  for (const note of ch.notes || []) {
    const n = el('p', 'line-note');
    n.append(highlighted(note));
    body.append(n);
  }
  li.append(renderIcons(ch), body);
  return li;
}

/**
 * Render a <ul> of lines.
 * @param {object[]} changes
 * @returns {HTMLElement}
 */
function renderLines(changes) {
  const ul = el('ul', 'lines');
  for (const ch of changes) ul.append(renderLine(ch));
  return ul;
}

/**
 * Build a card heading from its title parts: "Druid › Restoration" or
 * "Dungeons › The Deadmines". The first part is the strong one, later parts
 * (tree / group) are lighter, so one line carries the whole path and nothing
 * above it repeats the class or category name. General headings take part in
 * search highlighting (category and group are searchable); class headings
 * are plain.
 * @param {string[]} title parts
 * @param {boolean} highlight wrap search matches in <mark>
 * @returns {HTMLElement} <h3>
 */
function renderHeading(title, highlight) {
  const h = el('h3', 'card-title');
  title.forEach((part, i) => {
    if (i) h.append(el('span', 'crumb-sep', ' › '));
    const span = el('span', i ? 'crumb-sub' : 'crumb-main');
    if (highlight) span.append(highlighted(part)); else span.textContent = part;
    h.append(span);
  });
  return h;
}

/**
 * Render one card: a class (or "All classes") or one general category, with
 * one or more sibling headings, each followed by its lines.
 * @param {{kind: string, class: string|null, headings: object[]}} card from flattenSections
 * @returns {HTMLElement}
 */
function renderCard(card) {
  const box = el('section', `card card-${card.kind}`);
  // The class colour is exposed as a CSS variable and used only as an accent.
  box.style.setProperty('--cc', card.kind === 'class' ? (classColor(card.class) || 'var(--accent)') : 'var(--muted)');
  for (const h of card.headings) {
    box.append(renderHeading(h.title, card.kind === 'general'), renderLines(h.changes));
  }
  return box;
}

/** Visible badge text per day kind. The text (not only the colour) tells them apart. */
const KIND_LABEL = { hotfix: 'Hotfix', patch: 'Patch' };

/**
 * Build the small "Source" link for a day, or null when the day has no
 * usable `sourceUrl`. Only http(s) URLs are accepted (the data file is not
 * trusted blindly); the link opens in a new tab with rel="noopener".
 * @param {object} day
 * @returns {HTMLAnchorElement|null}
 */
function sourceLink(day) {
  const url = day.sourceUrl;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const a = el('a', 'day-source', 'Source');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', `Source for the ${KIND_LABEL[dayKind(day)].toLowerCase()} of ${day.label || day.date} (opens in a new tab)`);
  return a;
}

/**
 * Render one day: sticky heading (date, kind badge, optional patch title,
 * relative hint, Source link, count) and its sections. Hotfix and patch days
 * get a different class so patches stand out while scrolling.
 * @param {object} day a day from the data
 * @param {object[]} changes the visible changes of that day (already filtered,
 *   so the count below always reflects what is shown)
 * @returns {HTMLElement}
 */
function renderDay(day, changes) {
  const view = flattenSections(changes);
  const kind = dayKind(day);
  const sec = el('section', `day day-${kind}`);
  // Date + kind: two days on the same date need different anchors.
  sec.id = `d-${dayKey(day).replace('|', '-')}`;
  const head = el('h2', 'day-heading');
  head.append(el('span', 'day-label', day.label || day.date));
  // Badge and title live in one group so they wrap together on narrow screens
  // ("Patch · Beta build notes" never breaks right after the badge).
  const kindGroup = el('span', 'day-kind');
  kindGroup.append(el('span', `kind-badge kind-${kind}`, KIND_LABEL[kind]));
  // The title is shown for patch days only.
  if (kind === 'patch' && typeof day.title === 'string' && day.title.trim()) {
    kindGroup.append(el('span', 'day-title', day.title.trim()));
  }
  head.append(kindGroup);
  head.append(el('span', 'day-rel', relativeDay(day.date)));
  const src = sourceLink(day);
  if (src) head.append(src);
  head.append(el('span', 'day-count', `${view.count} ${view.count === 1 ? 'change' : 'changes'}`));
  sec.append(head);
  for (const card of view.cards) sec.append(renderCard(card));
  return sec;
}

/**
 * Re-render the results area for the current state; shows an empty state
 * (with a clear button) when the filters match nothing.
 */
function renderResults() {
  terms = queryTerms(state.q);
  const days = visibleDays(data, state);
  const total = days.reduce((n, d) => n + d.changes.length, 0);
  $('live').textContent = `${total} ${total === 1 ? 'change' : 'changes'} shown`;
  shownCount = total;
  renderFilterBar();
  if (!days.length) {
    // Name the kind filter when it is active: it is the easiest one to forget.
    const kindNote = state.kind === 'all' ? ''
      : ` Only ${state.kind === 'patch' ? 'patch notes' : 'hotfixes'} are being shown; try "All" to include both.`;
    showStatus('Nothing matches', `No changes match the current filters.${kindNote}`, {
      label: 'Clear filters', onClick: () => setState(defaultState()),
    });
    return;
  }
  $('results').replaceChildren(...days.map(({ day, changes }) => renderDay(day, changes)));
}

/**
 * Create a toggle chip button.
 * @param {string} label visible text
 * @param {boolean} pressed aria-pressed state
 * @param {Function} onClick click handler
 * @param {string|null} [color] class colour for the dot (accent only)
 * @returns {HTMLButtonElement}
 */
function chip(label, pressed, onClick, color) {
  const b = el('button', 'chip');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  if (color) {
    b.style.setProperty('--cc', color);
    b.append(el('span', 'chip-dot'));
  }
  b.append(el('span', 'chip-label', label));
  b.addEventListener('click', onClick);
  return b;
}

/** Rebuild the class chip row from the current state. */
function renderClassChips() {
  const row = $('class-row');
  const chips = [chip('All classes', !state.cls, () => setState({ ...state, cls: '', spec: '' }))];
  for (const c of CLASSES) {
    chips.push(chip(c.name, state.cls === c.slug,
      () => setState({ ...state, cls: state.cls === c.slug ? '' : c.slug, spec: '' }), c.color));
  }
  row.replaceChildren(...chips);
  scrollPressedIntoView(row);
}

/**
 * Horizontally scroll a chip row so its selected chip is visible (matters on
 * phones, where the row scrolls). Adjusts only the row, never the page.
 * @param {HTMLElement} row
 */
function scrollPressedIntoView(row) {
  const on = row.querySelector('[aria-pressed="true"]');
  if (!on || row.scrollWidth <= row.clientWidth) return;
  row.scrollLeft = Math.max(0, on.offsetLeft - row.offsetLeft - 16);
}

/**
 * Rebuild the talent-tree row. Only shown once a class is chosen; offers the
 * vanilla trees plus any trees that appear in the data for that class.
 */
function renderSpecChips() {
  const row = $('spec-row');
  row.hidden = !state.cls;
  if (!state.cls) { row.replaceChildren(); return; }
  row.setAttribute('aria-label', `${className(state.cls)} talent tree`);
  const color = classColor(state.cls);
  const chips = [chip('All trees', !state.spec, () => setState({ ...state, spec: '' }), color)];
  for (const spec of specsForClass(data, state.cls)) {
    chips.push(chip(titleCase(spec), state.spec === spec,
      () => setState({ ...state, spec: state.spec === spec ? '' : spec }), color));
  }
  row.replaceChildren(...chips);
}

/**
 * Rebuild the category chip row: quick "All" / "None" buttons, then one
 * toggle chip per category that occurs in the data. Chips are multi-select
 * (aria-pressed); the row is hidden when the data has no categories.
 */
function renderCategoryChips() {
  const row = $('cat-row');
  row.hidden = !categories.length;
  if (!categories.length) { row.replaceChildren(); return; }
  const allOn = !state.cats;
  const noneOn = !!state.cats && state.cats.length === 0;
  /** Quick action button ("All"/"None"); disabled when it would change nothing. */
  const quick = (label, title, cats, disabled) => {
    const b = el('button', 'chip chip-quick', label);
    b.type = 'button';
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', () => setState({ ...state, cats }));
    return b;
  };
  const chips = [
    quick('All', 'Show every category', null, allOn),
    quick('None', 'Hide all non-class categories', [], noneOn),
  ];
  for (const c of categories) {
    chips.push(chip(c.label, isCategoryOn(state, c.slug),
      () => setState({ ...state, cats: toggleCategory(state.cats, c.slug, categories) })));
  }
  row.replaceChildren(...chips);
}

/** Segment labels of the kind filter, keyed by filter value. */
const KIND_FILTER_LABEL = { all: 'All', hotfix: 'Hotfixes', patch: 'Patches' };

/**
 * Build the three-way kind control "All / Hotfixes / Patches" as a radio
 * group: role=radiogroup with role=radio buttons, aria-checked, roving
 * tabindex (only the selected segment is in the tab order) and arrow-key
 * navigation, like a native radio group. Created once; renderKindFilter()
 * keeps it in sync with the state.
 * @returns {HTMLElement}
 */
function buildKindFilter() {
  const group = el('div', 'segmented');
  group.id = 'kind-row';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Show hotfixes or patch notes');
  for (const value of KIND_FILTERS) {
    const b = el('button', 'segment', KIND_FILTER_LABEL[value]);
    b.type = 'button';
    b.dataset.kind = value;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => setState({ ...state, kind: value }));
    group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const n = KIND_FILTERS.length;
    const next = KIND_FILTERS[(KIND_FILTERS.indexOf(state.kind) + step + n) % n];
    setState({ ...state, kind: next });
    group.querySelector(`[data-kind="${next}"]`).focus(); // setState keeps the buttons, so focus survives
  });
  return group;
}

/** Sync the kind control (checked segment, roving tabindex) with the state. */
function renderKindFilter() {
  for (const b of $('kind-row').children) {
    const on = b.dataset.kind === state.kind;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/**
 * Build the search box with its suggestion dropdown (ARIA combobox pattern:
 * input role=combobox -> listbox of role=option, aria-activedescendant tracks
 * the keyboard-highlighted option). The input is created once and never
 * re-rendered, so typing keeps focus; renderSearch() only syncs its value.
 * @returns {HTMLElement} wrapper containing label, input and listbox
 */
function buildSearch() {
  const wrap = el('div', 'search');
  const label = el('label', 'visually-hidden', 'Search changes by skill, item or text');
  label.htmlFor = 'search';
  const input = el('input', 'search-input');
  input.id = 'search';
  input.type = 'search';
  input.placeholder = 'Search skills…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'search';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'suggest');
  const list = el('ul', 'suggest');
  list.id = 'suggest';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Skill suggestions');
  list.hidden = true;
  wrap.append(label, input, list);

  /** Suggestions currently shown and the keyboard-highlighted index (-1 = none). */
  let items = [];
  let active = -1;

  /** Close the dropdown. */
  const close = () => {
    list.hidden = true;
    items = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  /** Mark option `i` active (visually + aria) and scroll it into view. */
  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', `sug-${i}`);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  /** Choose a suggestion: fill the search with its name and run it. */
  const choose = (sug) => {
    input.value = sug.name;
    close();
    setState({ ...state, q: sug.name }, { fromInput: true });
  };

  /** (Re)build the list for the text currently in the input and show it. */
  const open = () => {
    items = buildSuggestions(data, state, input.value);
    if (!items.length) { close(); return; }
    const inputTerms = queryTerms(input.value);
    list.replaceChildren(...items.map((sug, i) => {
      const li = el('li', 'suggest-item');
      li.id = `sug-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const ic = el('span', 'suggest-icon');
      const url = iconUrl(sug.icon);
      if (url) {
        const img = new Image(24, 24);
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove(), { once: true }); // leaves the neutral tile
        img.src = url;
        ic.append(img);
      }
      const name = el('span', 'suggest-name');
      for (const seg of highlightSegments(sug.label, inputTerms)) {
        name.append(seg.match ? el('mark', null, seg.text) : document.createTextNode(seg.text));
      }
      li.append(ic, name, el('span', 'suggest-count', `\u00D7${sug.count}`));
      li.addEventListener('click', () => choose(sug));
      return li;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  };

  input.addEventListener('focus', open);
  input.addEventListener('click', () => { if (list.hidden) open(); });
  input.addEventListener('input', () => {
    setState({ ...state, q: input.value }, { fromInput: true });
    open();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { open(); if (list.hidden) return; }
      const n = items.length;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0) { e.preventDefault(); choose(items[active]); }
      else close();
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); close(); }
    } else if (e.key === 'Tab') {
      close();
    }
  });
  // Keep focus in the input while pressing/tapping an option (blur would close the list first).
  list.addEventListener('mousedown', (e) => e.preventDefault());
  wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) close(); });
  return wrap;
}

/** Sync the search input with state.q (e.g. after Clear or a hash change). */
function renderSearch() {
  const input = $('search');
  if (input.value !== state.q) input.value = state.q;
}

/**
 * Publish the filter bar height as --bar-h so the sticky date headings sit
 * right below the sticky bar on mobile (CSS ignores it on desktop).
 * @param {HTMLElement} box the filter panel
 */
function watchBarHeight(box) {
  const set = () => document.documentElement.style.setProperty('--bar-h', `${box.offsetHeight}px`);
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(box);
  else window.addEventListener('resize', set);
}

/**
 * Build the original inline "sliders" icon for the filter button (three
 * lines with knobs). Decorative: the button carries the accessible name.
 * @returns {SVGElement}
 */
function filterIconSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  // Three rails with a gap where each knob sits.
  path.setAttribute('d', 'M4 6h8 M18 6h2 M4 12h2 M12 12h8 M4 18h10 M20 18h0');
  svg.append(path);
  for (const [cx, cy] of [[15, 6], [9, 12], [17, 18]]) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', '2.2');
    svg.append(c);
  }
  return svg;
}

/** Narrow-screen query: below this width the filters live in a bottom sheet. */
const sheetQuery = window.matchMedia('(max-width: 899px)');

/** Is the filter sheet currently open? (Only ever true on narrow screens.) */
let panelOpen = false;

/**
 * Open or close the filter sheet. While open: the panel is a modal dialog,
 * the page behind cannot scroll, focus moves into the panel; closing returns
 * focus to the filter button. On wide screens the panel is the sidebar and
 * this does nothing.
 * @param {boolean} open
 * @param {boolean} [moveFocus] move focus in/out (false when reacting to the URL or a resize)
 */
function setPanelOpen(open, moveFocus = true) {
  const want = open && sheetQuery.matches;
  if (want === panelOpen) return;
  panelOpen = want;
  const panel = $('filter-panel');
  $('filters').classList.toggle('panel-open', want);
  document.documentElement.classList.toggle('sheet-open', want);
  $('filters-btn').setAttribute('aria-expanded', String(want));
  // Dialog semantics only apply while it really behaves like a dialog.
  if (want) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'panel-title');
    if (moveFocus) $('panel-title').focus();
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('aria-labelledby');
    if (moveFocus) $('filters-btn').focus();
  }
  syncHash();
}

/**
 * Keep Tab inside the open sheet (a simple focus trap): from the last
 * control it wraps to the first and the other way round.
 * @param {KeyboardEvent} e keydown
 */
function trapFocus(e) {
  if (!panelOpen || e.key !== 'Tab') return;
  const items = [...$('filter-panel').querySelectorAll('button:not(:disabled), [tabindex="0"]')]
    .filter((n) => !n.closest('[hidden]'));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === $('panel-title') || !$('filter-panel').contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !$('filter-panel').contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Build the (static) filter structure once:
 *   .filters-bar   search + filter button (narrow screens)
 *   .filter-summary one-line summary of the active filters (narrow screens)
 *   .filter-panel  kind, class, tree and category controls, Clear, Done
 * On wide screens the panel is simply part of the sidebar.
 */
function buildFilters() {
  const box = $('filters');

  // --- bar: search and the filter button
  const btn = el('button', 'filter-btn');
  btn.type = 'button';
  btn.id = 'filters-btn';
  btn.setAttribute('aria-label', 'Filters');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'filter-panel');
  btn.append(filterIconSvg(), el('span', 'badge'));
  btn.lastChild.id = 'filters-badge';
  btn.addEventListener('click', () => setPanelOpen(!panelOpen));
  const bar = el('div', 'filters-bar');
  bar.append(buildSearch(), btn);

  const summary = el('button', 'filter-summary');
  summary.type = 'button';
  summary.id = 'filter-summary';
  summary.hidden = true;
  summary.title = 'Change filters';
  summary.addEventListener('click', () => setPanelOpen(true));

  // --- panel
  const classGroup = el('div', 'chip-row');
  classGroup.id = 'class-row';
  classGroup.setAttribute('role', 'group');
  classGroup.setAttribute('aria-label', 'Class');
  const specGroup = el('div', 'chip-row');
  specGroup.id = 'spec-row';
  specGroup.setAttribute('role', 'group');
  specGroup.hidden = true;
  // Category chips (non-class changes): multi-select row built by renderCategoryChips().
  const catGroup = el('div', 'chip-row chip-row-cats');
  catGroup.id = 'cat-row';
  catGroup.setAttribute('role', 'group');
  catGroup.setAttribute('aria-label', 'Categories');

  const title = el('h2', 'panel-title', 'Filters');
  title.id = 'panel-title';
  title.tabIndex = -1;
  const clear = el('button', 'btn-clear', 'Clear filters');
  clear.type = 'button';
  clear.id = 'clear-filters';
  clear.addEventListener('click', () => setState(defaultState()));
  const head = el('div', 'panel-head');
  head.append(title, clear);

  const done = el('button', 'btn done-btn', 'Done');
  done.type = 'button';
  done.id = 'done-btn';
  done.addEventListener('click', () => setPanelOpen(false));
  const foot = el('div', 'panel-foot');
  foot.append(done);

  const panel = el('div', 'filter-panel');
  panel.id = 'filter-panel';
  panel.append(
    head,
    el('p', 'filter-label', 'Show'), buildKindFilter(),
    el('p', 'filter-label', 'Class'), classGroup, specGroup,
    el('p', 'filter-label', 'Categories'), catGroup,
    foot,
  );

  const backdrop = el('div', 'filter-backdrop');
  backdrop.addEventListener('click', () => setPanelOpen(false));

  // Polite live region so screen readers hear how many changes are shown.
  const live = el('p', 'visually-hidden');
  live.id = 'live';
  live.setAttribute('role', 'status');
  box.replaceChildren(bar, summary, backdrop, panel, live);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) { e.preventDefault(); setPanelOpen(false); }
    else trapFocus(e);
  });
  // Rotating a tablet / resizing to desktop turns the sheet into the sidebar.
  sheetQuery.addEventListener('change', () => { if (!sheetQuery.matches) setPanelOpen(false, false); });
  watchBarHeight(box);
}

/** How many changes are shown right now (for the sheet's "Show N changes" button). */
let shownCount = 0;

/**
 * Sync the narrow-screen bar with the state: badge (number of active
 * filters), the button's accessible name, the one-line summary and the Done
 * button's label.
 */
function renderFilterBar() {
  const n = activeFilterCount(state);
  const badge = $('filters-badge');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  $('filters-btn').setAttribute('aria-label', n ? `Filters, ${n} active` : 'Filters');
  const text = filterSummary(state, categories);
  const sum = $('filter-summary');
  sum.hidden = !text;
  sum.textContent = text;
  $('done-btn').textContent = `Show ${shownCount} ${shownCount === 1 ? 'change' : 'changes'}`;
}

/** Sync the clear button with the state (enabled only when something differs from the defaults). */
function renderTools() {
  const d = defaultState();
  const dirty = state.cls !== d.cls || state.spec !== d.spec || state.q !== d.q || state.cats !== d.cats || state.kind !== d.kind;
  $('clear-filters').disabled = !dirty;
}

/** localStorage key for the remembered class/spec. */
const STORAGE_KEY = 'wow4ever.filter';

/**
 * Remember the class/spec for the next visit. localStorage can throw
 * (private mode, blocked storage), so every access is wrapped.
 * @param {{cls: string, spec: string}} st
 */
function saveSelection(st) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cls: st.cls, spec: st.spec }));
  } catch (_) { /* storage unavailable: ignore */ }
}

/**
 * Read the remembered class/spec (validated), or null.
 * @returns {{cls: string, spec: string}|null}
 */
function loadSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const sel = sanitizeSelection(v && v.cls, v && v.spec);
    return sel.cls ? sel : null;
  } catch (_) {
    return null;
  }
}

/**
 * Decide the initial state: the URL hash wins; with an empty hash restore
 * the last class/spec from localStorage.
 * @returns {object} state
 */
function initialState() {
  // A hash that only carries the UI flag (#filters=open) has no filter in it:
  // fall through to the remembered class like an empty hash.
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  params.delete('filters');
  if (params.toString()) return decodeHash(location.hash);
  return { ...defaultState(), ...(loadSelection() || {}) };
}

/**
 * The hash that describes the current view: the filter state plus the
 * `filters=open` flag while the mobile sheet is open (so it can be shared).
 * @returns {string}
 */
function currentHash() {
  return withPanelFlag(encodeHash(state), panelOpen);
}

/**
 * Write the state into the URL hash (replaceState: typing must not flood the
 * browser history, and it does not fire hashchange).
 */
function syncHash() {
  const want = currentHash();
  if (want === location.hash) return;
  history.replaceState(null, '', want || location.pathname + location.search);
}

/**
 * Replace the state, then refresh filters and results.
 * @param {object} next new state
 */
function setState(next, opts = {}) {
  // One canonical `cats` (null when every chip is on), whatever the source.
  state = { ...next, cats: normalizeCats(next.cats, categories) };
  syncHash();
  saveSelection(state);
  if (!opts.fromInput) renderSearch();
  renderClassChips();
  renderSpecChips();
  renderCategoryChips();
  renderKindFilter();
  renderTools();
  renderResults();
}

/** Render everything that depends on the data. */
function render() {
  renderHeader();
  categories = availableCategories(data);
  buildFilters();
  // Read the UI flag first: setState() rewrites the hash without it.
  const openAtStart = hasPanelFlag(location.hash);
  state = initialState();
  setState(state);
  // #filters=open opens the sheet right away (narrow screens only).
  if (openAtStart) setPanelOpen(true, false);
  // Back/forward or a manually edited hash: re-read the state from the URL.
  window.addEventListener('hashchange', () => {
    if (currentHash() === location.hash) return;
    setPanelOpen(hasPanelFlag(location.hash), false);
    if (encodeHash(state) !== encodeHash(decodeHash(location.hash))) setState(decodeHash(location.hash));
  });
}

/** Load the data, handle failure with a retry button, then render. */
async function boot() {
  showStatus('Loading changes…', 'Fetching the latest hotfix data.');
  try {
    data = await loadData();
  } catch (err) {
    $('updated').textContent = 'Last updated: unavailable';
    showStatus(
      'Could not load the changes',
      `The data file could not be loaded (${err.message}). Check your connection and try again.`,
      { label: 'Try again', onClick: boot },
      true
    );
    return;
  }
  render();
}

boot();
