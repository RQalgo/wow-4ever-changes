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

/** Render everything that depends on the data. */
function render() {
  renderHeader();
  $('results').replaceChildren(el('p', 'status', `${data.days.length} days loaded.`));
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
