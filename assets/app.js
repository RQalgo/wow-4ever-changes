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
 */

/** Shortcut for document.getElementById. */
const $ = (id) => document.getElementById(id);

/** Start the app once the module is loaded. */
function boot() {
  $('results').textContent = 'Loading changes…';
}

boot();
