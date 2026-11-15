/**
 * logic.js - pure, DOM-free logic for "WoW: Forever - Changes at a Glance".
 *
 * Everything here is deterministic and unit tested (test/ui-logic.test.mjs),
 * so it must never touch `document`, `window` or `localStorage`.
 *
 * Sections:
 *   1. Constants      : class list/colours, vanilla talent trees, labels
 *   2. Dates          : relative day hints
 *   3. Grouping       : turn a day's changes into class/spec/general sections
 *   4. Filtering      : class/spec/general semantics
 *   5. Search         : matching and highlight segmentation
 *   6. Suggestions    : skill-name suggestions for the search box
 *   7. URL hash state : encode / decode the shareable filter state
 */

/* ======================= 1. Constants ======================= */

/** Playable classes (slug -> display name and accent colour). */
export const CLASSES = [
  { slug: 'druid', name: 'Druid', color: '#FF7C0A' },
  { slug: 'hunter', name: 'Hunter', color: '#AAD372' },
  { slug: 'mage', name: 'Mage', color: '#3FC7EB' },
  { slug: 'paladin', name: 'Paladin', color: '#F48CBA' },
  { slug: 'priest', name: 'Priest', color: '#FFFFFF' },
  { slug: 'rogue', name: 'Rogue', color: '#FFF468' },
  { slug: 'shaman', name: 'Shaman', color: '#0070DD' },
  { slug: 'warlock', name: 'Warlock', color: '#8788EE' },
  { slug: 'warrior', name: 'Warrior', color: '#C69B6D' },
];

/** Known vanilla talent trees per class slug (merged with trees seen in data). */
export const VANILLA_SPECS = {
  druid: ['balance', 'feral-combat', 'restoration'],
  hunter: ['beast-mastery', 'marksmanship', 'survival'],
  mage: ['arcane', 'fire', 'frost'],
  paladin: ['holy', 'protection', 'retribution'],
  priest: ['discipline', 'holy', 'shadow'],
  rogue: ['assassination', 'combat', 'subtlety'],
  shaman: ['elemental', 'enhancement', 'restoration'],
  warlock: ['affliction', 'demonology', 'destruction'],
  warrior: ['arms', 'fury', 'protection'],
};

/**
 * Turn a slug such as "beast-mastery" into "Beast Mastery".
 * @param {string} slug
 * @returns {string}
 */
export function titleCase(slug) {
  return String(slug || '')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Display name for a class slug ("paladin" -> "Paladin"); null -> "All classes".
 * @param {string|null} slug
 * @returns {string}
 */
export function className(slug) {
  if (!slug) return 'All classes';
  const known = CLASSES.find((c) => c.slug === slug);
  return known ? known.name : titleCase(slug);
}

/**
 * Accent colour for a class slug, or null when unknown / "all classes".
 * @param {string|null} slug
 * @returns {string|null}
 */
export function classColor(slug) {
  const known = CLASSES.find((c) => c.slug === slug);
  return known ? known.color : null;
}

/* ======================= 2. Dates ======================= */

/**
 * Human relative hint for an ISO date ("2026-11-13") compared with `now`.
 * Both are reduced to UTC calendar days so the result does not depend on the
 * time of day or the viewer's time zone.
 * @param {string} isoDate YYYY-MM-DD
 * @param {Date} [now]
 * @returns {string} e.g. "today", "yesterday", "3 days ago", "2 weeks ago"
 */
export function relativeDay(isoDate, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || '');
  if (!m) return '';
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((today - then) / 86400000);
  if (days < 0) return 'upcoming';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/* ======================= 3. Grouping ======================= */

/**
 * Group one day's (already filtered) changes into the structure the UI draws.
 *
 * classSections: "All classes" first, then classes alphabetically. Inside a
 *   class, `direct` holds lines with spec null and `specs` the per-tree
 *   groups (alphabetical).
 * general: every scope:"general" change, grouped by category (first-seen
 *   order) and then by `group` (ungrouped lines first, then groups in
 *   first-seen order).
 *
 * @param {object[]} changes changes of a single day
 * @returns {{classSections: object[], general: object[], count: number}}
 */
export function groupChanges(changes) {
  const classMap = new Map(); // class slug|null -> {direct: [], specs: Map}
  const catMap = new Map(); // category -> Map(group|null -> changes[])

  for (const ch of changes) {
    if (ch.scope === 'general') {
      if (!catMap.has(ch.category)) catMap.set(ch.category, new Map());
      const groups = catMap.get(ch.category);
      const g = ch.group || null;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ch);
    } else {
      const key = ch.class || null;
      if (!classMap.has(key)) classMap.set(key, { direct: [], specs: new Map() });
      const sec = classMap.get(key);
      if (ch.spec) {
        if (!sec.specs.has(ch.spec)) sec.specs.set(ch.spec, []);
        sec.specs.get(ch.spec).push(ch);
      } else {
        sec.direct.push(ch);
      }
    }
  }

  const classKeys = [...classMap.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === null) return -1; // "All classes" always first
    if (b === null) return 1;
    return className(a).localeCompare(className(b));
  });
  const classSections = classKeys.map((key) => {
    const sec = classMap.get(key);
    const specs = [...sec.specs.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((spec) => ({ spec, label: titleCase(spec), changes: sec.specs.get(spec) }));
    return { class: key, label: className(key), direct: sec.direct, specs };
  });

  const general = [...catMap.entries()].map(([category, groups]) => {
    // Map preserves insertion order; move the ungrouped (null) bucket first.
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0));
    return {
      category,
      groups: ordered.map(([group, list]) => ({ group, changes: list })),
    };
  });

  return { classSections, general, count: changes.length };
}

/* ======================= 5. Search (defined first; used by filtering) ======================= */

/**
 * Split a query into lower-cased words (whitespace separated, empty dropped).
 * @param {string} q
 * @returns {string[]}
 */
export function queryTerms(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The text a search is run against: line text, notes, subject names, group
 * and category, lower-cased and joined.
 * @param {object} ch change
 * @returns {string}
 */
export function searchHaystack(ch) {
  return [ch.text, ...(ch.notes || []), ...(ch.subjects || []).map((s) => s.name), ch.group, ch.category]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/**
 * Case-insensitive search: every word of the query must appear somewhere in
 * the haystack. An empty query matches everything.
 * @param {object} ch change
 * @param {string} q raw query
 * @returns {boolean}
 */
export function matchesQuery(ch, q) {
  const terms = queryTerms(q);
  if (!terms.length) return true;
  const hay = searchHaystack(ch);
  return terms.every((t) => hay.includes(t));
}

/**
 * Split text into segments marking where query words match, so the UI can
 * wrap matches in <mark> using DOM nodes (no HTML strings).
 * @param {string} text
 * @param {string[]} terms lower-case query words
 * @returns {{text: string, match: boolean}[]}
 */
export function highlightSegments(text, terms) {
  const str = String(text == null ? '' : text);
  if (!terms || !terms.length) return [{ text: str, match: false }];
  // Longest words first so "judgement" wins over "judge" at the same offset.
  const sorted = [...new Set(terms)].sort((a, b) => b.length - a.length);
  const re = new RegExp(sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const out = [];
  let last = 0;
  for (const m of str.matchAll(re)) {
    if (m[0] === '') continue;
    if (m.index > last) out.push({ text: str.slice(last, m.index), match: false });
    out.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ text: str.slice(last), match: false });
  return out.length ? out : [{ text: str, match: false }];
}

/* ======================= 4. Filtering ======================= */

/**
 * Create the default (unfiltered) UI state.
 * @returns {{cls: string, spec: string, q: string, general: boolean}}
 */
export function defaultState() {
  return { cls: '', spec: '', q: '', general: true };
}

/**
 * Class/talent-tree filter for one *class-scope* change.
 *  - no class chosen: everything passes
 *  - lines with class null ("All classes") always pass
 *  - class chosen: only that class passes (every spec)
 *  - spec also chosen: that spec's lines, plus the class's lines with
 *    spec null (they apply to the spec as well)
 * @param {object} ch class-scope change
 * @param {{cls: string, spec: string}} state
 * @returns {boolean}
 */
export function matchesClassFilter(ch, state) {
  if (!state.cls) return true;
  if (!ch.class) return true;
  if (ch.class !== state.cls) return false;
  if (!state.spec) return true;
  return !ch.spec || ch.spec === state.spec;
}

/**
 * Full filter for one change: General toggle, class/spec and (when present)
 * the search text. General changes ignore the class filter but obey the
 * General toggle; class-scope changes ignore the toggle.
 * @param {object} ch
 * @param {object} state
 * @returns {boolean}
 */
export function matchesState(ch, state) {
  if (ch.scope === 'general') {
    if (!state.general) return false;
  } else if (!matchesClassFilter(ch, state)) {
    return false;
  }
  return matchesQuery(ch, state.q);
}

/**
 * Apply the state to the whole dataset and drop days with nothing left.
 * @param {{days: object[]}} data
 * @param {object} state
 * @returns {{day: object, changes: object[]}[]} visible days (newest first, as in data)
 */
export function visibleDays(data, state) {
  const out = [];
  for (const day of data.days || []) {
    const changes = (day.changes || []).filter((c) => matchesState(c, state));
    if (changes.length) out.push({ day, changes });
  }
  return out;
}

/**
 * Talent trees to offer for a class: the known vanilla trees plus any extra
 * spec slugs that appear in the data for that class (e.g. a new tree).
 * Vanilla trees keep their canonical order; extras follow alphabetically.
 * @param {{days: object[]}} data
 * @param {string} cls class slug
 * @returns {string[]} spec slugs
 */
export function specsForClass(data, cls) {
  if (!cls) return [];
  const base = VANILLA_SPECS[cls] || [];
  const extra = new Set();
  for (const day of data.days || []) {
    for (const c of day.changes || []) {
      if (c.class === cls && c.spec && !base.includes(c.spec)) extra.add(c.spec);
    }
  }
  return [...base, ...[...extra].sort()];
}

/* ======================= Icons ======================= */

/**
 * Build the Wowhead icon URL for an icon name, or null when the name is
 * missing or has unexpected characters (defence against malformed data).
 * @param {string|undefined} icon icon name without extension
 * @returns {string|null}
 */
export function iconUrl(icon) {
  if (!icon || !/^[A-Za-z0-9_\-]+$/.test(icon)) return null;
  return `https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg`;
}

/**
 * Pick which fallback glyph a change should get when it has no usable icon.
 * Class lines share one glyph (the tile colour tells the class); General
 * lines get a neutral glyph per category.
 * @param {object} ch change
 * @returns {'spark'|'gem'|'scroll'|'arch'|'hex'}
 */
export function glyphKey(ch) {
  if (ch.scope !== 'general') return 'spark';
  const cat = String(ch.category || '').toLowerCase();
  if (/item|gear|equipment/.test(cat)) return 'gem';
  if (/quest/.test(cat)) return 'scroll';
  if (/dungeon|raid|instance/.test(cat)) return 'arch';
  return 'hex';
}

/* ======================= 6. Suggestions ======================= */

/**
 * Build search-box suggestions from `subjects[].name` across the data.
 *
 * - Only changes passing the class/spec filter and the General toggle count
 *   (the search text itself is ignored here, otherwise the list would shrink
 *   to the thing already typed).
 * - Ranked by how many changes mention the subject (most frequent first),
 *   then alphabetically.
 * - Empty query: SKILL names only (type "spell"). Typing widens this to every
 *   subject (items too) and narrows by the text: prefix matches first, then
 *   substring matches, each group keeping the frequency order.
 *
 * @param {{days: object[]}} data
 * @param {object} state current UI state (cls/spec/general used)
 * @param {string} query text currently typed
 * @param {number} [limit] max suggestions
 * @returns {{name: string, icon: string, type: string, count: number}[]}
 */
export function buildSuggestions(data, state, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  const filterState = { ...state, q: '' };
  const tally = new Map(); // lower-cased name -> suggestion

  for (const day of data.days || []) {
    for (const ch of day.changes || []) {
      if (!matchesState(ch, filterState)) continue;
      const seen = new Set(); // count a subject once per change
      for (const sub of ch.subjects || []) {
        if (!sub || !sub.name) continue;
        const key = sub.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!q && sub.type !== 'spell') continue; // default list: skills only
        const entry = tally.get(key) || { name: sub.name, icon: sub.icon, type: sub.type, count: 0 };
        entry.count += 1;
        tally.set(key, entry);
      }
    }
  }

  const byFrequency = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  let list = [...tally.values()];
  if (q) {
    const prefix = list.filter((s) => s.name.toLowerCase().startsWith(q)).sort(byFrequency);
    const rest = list.filter((s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q)).sort(byFrequency);
    list = [...prefix, ...rest];
  } else {
    list.sort(byFrequency);
  }
  return list.slice(0, limit);
}

/* ======================= 7. URL hash state ======================= */

/**
 * Validate a class/spec pair coming from untrusted input (URL hash or
 * localStorage). Unknown classes are dropped; a spec needs a class and must
 * look like a slug.
 * @param {unknown} cls
 * @param {unknown} spec
 * @returns {{cls: string, spec: string}}
 */
export function sanitizeSelection(cls, spec) {
  const c = typeof cls === 'string' && CLASSES.some((k) => k.slug === cls) ? cls : '';
  const sp = c && typeof spec === 'string' && /^[a-z0-9-]{1,40}$/.test(spec) ? spec : '';
  return { cls: c, spec: sp };
}

/**
 * Encode the state as a hash such as "#class=paladin&spec=retribution&q=judgement&general=0".
 * Default values are omitted; the default state encodes to "" (no hash).
 * @param {{cls: string, spec: string, q: string, general: boolean}} state
 * @returns {string} "" or a string starting with "#"
 */
export function encodeHash(state) {
  const p = new URLSearchParams();
  if (state.cls) p.set('class', state.cls);
  if (state.cls && state.spec) p.set('spec', state.spec);
  if (state.q) p.set('q', state.q);
  if (!state.general) p.set('general', '0');
  const str = p.toString();
  return str ? `#${str}` : '';
}

/**
 * Decode a location hash back into a state. Unknown/invalid values fall back
 * to defaults, so a hand-edited URL can never break the page.
 * @param {string} hash e.g. "#class=paladin&q=judgement" (the "#" is optional)
 * @returns {{cls: string, spec: string, q: string, general: boolean}}
 */
export function decodeHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const { cls, spec } = sanitizeSelection(p.get('class'), p.get('spec'));
  return {
    cls,
    spec,
    q: (p.get('q') || '').slice(0, 100),
    general: p.get('general') !== '0',
  };
}
