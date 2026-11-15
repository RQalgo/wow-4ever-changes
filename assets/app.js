/**
 * app.js - entry point (ES module) for "WoW: Forever - Changes at a Glance".
 *
 * Responsibilities:
 *   - load ./data/changes.json and show loading / error / empty states
 *   - own the UI state (class, spec, query, showGeneral) and re-render
 *   - build every DOM node with createElement/textContent (data is never
 *     inserted through innerHTML)
 *
 * Pure logic (filtering, search, suggestions, hash encoding) lives in
 * ./logic.js so it can be unit tested without a DOM.
 *
 * Sections: helpers, data loading, rendering, boot.
 */

import {
  CLASSES, groupChanges, relativeDay, classColor, defaultState, visibleDays, specsForClass, titleCase, className,
} from './logic.js';

/** Current UI state: class, spec, search text, General toggle. */
let state = defaultState();

/** The loaded dataset (see docs/SCHEMA.md), or null before loading. */
let data = null;

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

/**
 * Render one change line (text only for now; icons, notes and highlighting
 * are layered on in later steps).
 * @param {object} ch a change from the data
 * @returns {HTMLElement} <li>
 */
function renderLine(ch) {
  const li = el('li', 'line');
  const body = el('div', 'line-body');
  body.append(el('p', 'line-text', ch.text));
  for (const note of ch.notes || []) body.append(el('p', 'line-note', note));
  li.append(body);
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
 * Render a class section ("Paladin" with direct lines and per-spec
 * sub-headings such as "Paladin > Retribution").
 * @param {{class: string|null, label: string, direct: object[], specs: object[]}} sec
 * @returns {HTMLElement}
 */
function renderClassSection(sec) {
  const box = el('section', 'group group-class');
  // The class colour is exposed as a CSS variable and used only as an accent.
  box.style.setProperty('--cc', classColor(sec.class) || 'var(--accent)');
  box.append(el('h3', 'group-title', sec.label));
  if (sec.direct.length) box.append(renderLines(sec.direct));
  for (const sp of sec.specs) {
    const sub = el('div', 'subgroup');
    sub.append(el('h4', 'subgroup-title', `${sec.label} › ${sp.label}`), renderLines(sp.changes));
    box.append(sub);
  }
  return box;
}

/**
 * Render the General section: category headings, then optional group
 * headings (e.g. a dungeon name) with their lines.
 * @param {{category: string, groups: object[]}[]} general
 * @returns {HTMLElement}
 */
function renderGeneral(general) {
  const box = el('section', 'group group-general');
  box.append(el('h3', 'group-title', 'General'));
  for (const cat of general) {
    const sub = el('div', 'subgroup');
    sub.append(el('h4', 'subgroup-title', cat.category));
    for (const g of cat.groups) {
      if (g.group) sub.append(el('h5', 'group-label', g.group));
      sub.append(renderLines(g.changes));
    }
    box.append(sub);
  }
  return box;
}

/**
 * Render one date: sticky heading (published label, relative hint, count)
 * and its sections.
 * @param {object} day a day from the data
 * @param {object[]} changes the visible changes of that day
 * @returns {HTMLElement}
 */
function renderDay(day, changes) {
  const view = groupChanges(changes);
  const sec = el('section', 'day');
  sec.id = `d-${day.date}`;
  const head = el('h2', 'day-heading');
  head.append(
    el('span', 'day-label', day.label || day.date),
    el('span', 'day-rel', relativeDay(day.date)),
    el('span', 'day-count', `${view.count} ${view.count === 1 ? 'change' : 'changes'}`)
  );
  sec.append(head);
  for (const c of view.classSections) sec.append(renderClassSection(c));
  if (view.general.length) sec.append(renderGeneral(view.general));
  return sec;
}

/**
 * Re-render the results area for the current state; shows an empty state
 * (with a clear button) when the filters match nothing.
 */
function renderResults() {
  const days = visibleDays(data, state);
  if (!days.length) {
    showStatus('Nothing matches', 'No changes match the current filters.', {
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

/** Build the (static) filter panel structure once. */
function buildFilters() {
  const box = $('filters');
  const classGroup = el('div', 'chip-row');
  classGroup.id = 'class-row';
  classGroup.setAttribute('role', 'group');
  classGroup.setAttribute('aria-label', 'Class');
  const specGroup = el('div', 'chip-row');
  specGroup.id = 'spec-row';
  specGroup.setAttribute('role', 'group');
  specGroup.hidden = true;
  box.replaceChildren(classGroup, specGroup);
}

/**
 * Replace the state, then refresh filters and results.
 * @param {object} next new state
 */
function setState(next) {
  state = next;
  renderClassChips();
  renderSpecChips();
  renderResults();
}

/** Render everything that depends on the data. */
function render() {
  renderHeader();
  buildFilters();
  setState(state);
}

/** Load the data, handle failure with a retry button, then render. */
async function boot() {
  showStatus('Loading changes…', 'Fetching the latest hotfix data.');
  try {
    data = await loadData();
  } catch (err) {
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
