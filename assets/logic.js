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
  return true;
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
