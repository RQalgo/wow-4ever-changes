/**
 * logic.js - pure, DOM-free logic for "WoW: Forever - Changes at a Glance".
 *
 * Everything here is deterministic and unit tested (test/ui-logic.test.mjs),
 * so it must never touch `document`, `window` or `localStorage`.
 *
 * Sections:
 *   1. Constants      : class list/colours, vanilla talent trees, labels
 *   1b. Tags          : category vocabulary, effectiveTags (schema v3 + fallback)
 *   2. Dates          : relative day hints
 *   3. Grouping       : turn a day's changes into class/spec/general sections
 *   4. Filtering      : class/spec/general semantics
 *   5. Search         : matching and highlight segmentation
 *   6. Suggestions    : skill-name suggestions for the search box
 *   7. URL hash state : encode / decode the shareable filter state
 *   8. Day kinds      : hotfix vs patch (schema v2), day identity, kind filter
 *   9. Line decoration: extra tag chips and the icon cluster of one line
 *
 * Filtering never reads `scope`/`class`/`category` directly any more: every
 * filter goes through effectiveTags(), which returns the schema v3 `tags` when
 * a change has them and derives equivalent tags from the old fields otherwise.
 * That keeps the app working with both the current data (no tags yet) and the
 * v3 data that a scheduled job will publish later.
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
  druid: ['balance', 'feral', 'restoration'],
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

/* ======================= 1b. Tags (schema v3) ======================= */

/**
 * The category chips the UI can offer, in display order. `slug` is the tag
 * used in `change.tags`; `label` is the chip text.
 */
export const CATEGORIES = [
  { slug: 'items', label: 'Items' },
  { slug: 'quests', label: 'Quests' },
  { slug: 'dungeons', label: 'Dungeons' },
  { slug: 'professions', label: 'Professions' },
  { slug: 'pvp', label: 'PvP' },
  { slug: 'ui', label: 'Interface' },
  { slug: 'world', label: 'World & NPCs' },
  { slug: 'races', label: 'Races' },
  { slug: 'events', label: 'Events' },
  { slug: 'systems', label: 'Systems' },
  { slug: 'bugfix', label: 'Bug fixes' },
  { slug: 'known-issue', label: 'Known issues' },
  { slug: 'other', label: 'Other' },
];

/** Category slugs as a Set, for quick membership tests. */
const CATEGORY_SLUGS = new Set(CATEGORIES.map((c) => c.slug));

/**
 * Exact (lower-cased) published headings -> category tags. Headings that are
 * not listed here fall through to the "known issue" substring rule and then
 * to "other" (see categoryOfHeading).
 */
const HEADING_TAGS = {
  'items': ['items'],
  'quests': ['quests'],
  'quests and world': ['quests', 'world'],
  'dungeons': ['dungeons'],
  'raids': ['dungeons'],
  'dungeons and raids': ['dungeons'],
  'professions': ['professions'],
  'player versus player': ['pvp'],
  'user interface': ['ui'],
  'user interface and accessibility': ['ui'],
  'cooldown manager': ['ui'],
  'gamepad support': ['ui'],
  'world': ['world'],
  'enemies and npcs': ['world'],
  'races': ['races'],
  'racial abilities and traits': ['races'],
  'legacy system': ['systems'],
  'bugfixes': ['bugfix'],
  'bug fixes': ['bugfix'],
  'stranglethorn fishing extravaganza': ['events'],
};

/**
 * Category tags for a published category heading (case-insensitive), e.g.
 * "Quests and World" -> ["quests", "world"]. "Classes" yields no category
 * (class lines are described by class/spec tags); an unknown heading is
 * "other".
 * @param {string|null|undefined} heading published `category`
 * @returns {string[]} category tag slugs (possibly empty)
 */
export function categoryOfHeading(heading) {
  const h = String(heading || '').trim().toLowerCase();
  if (!h || h === 'classes') return [];
  if (HEADING_TAGS[h]) return [...HEADING_TAGS[h]];
  // Blizzard words these headings in several ways ("Known Issues – New with
  // this build", "New to this build - Known Issues"), so match on substring.
  if (h.includes('known issue')) return ['known-issue'];
  return ['other'];
}

/**
 * The tags every filter works with. Returns `change.tags` unchanged when it
 * is a non-empty array (schema v3). Otherwise derives them from the old
 * fields: `class:<class>` and `spec:<class>/<spec>` from the published
 * heading, plus the category tag(s) mapped from `category` (only for lines
 * published outside "Classes").
 *
 * An "all classes" line (published under Classes with no class heading) has
 * no class tag and no category tag, so it can end up with an empty list.
 * @param {object} change
 * @returns {string[]}
 */
export function effectiveTags(change) {
  const ch = change || {};
  if (Array.isArray(ch.tags) && ch.tags.length) return ch.tags;
  const tags = [];
  if (ch.class) {
    tags.push(`class:${ch.class}`);
    if (ch.spec) tags.push(`spec:${ch.class}/${ch.spec}`);
  }
  // Class-scope lines carry the "Classes" heading, which has no category tag.
  if (ch.scope !== 'class') tags.push(...categoryOfHeading(ch.category));
  return [...new Set(tags)];
}

/**
 * Class slugs a change is tagged with (`class:<slug>` tags), in tag order.
 * @param {object} change
 * @returns {string[]}
 */
export function classTagsOf(change) {
  return effectiveTags(change).filter((t) => t.startsWith('class:')).map((t) => t.slice(6));
}

/**
 * Category tags of a change: every tag that is not `class:`, `spec:` or
 * `talent`. A tag outside the known vocabulary counts as "other" so that a
 * future tag can never make a line impossible to show.
 * @param {object} change
 * @returns {string[]} unique category slugs
 */
export function categoryTagsOf(change) {
  const out = [];
  for (const t of effectiveTags(change)) {
    if (t.startsWith('class:') || t.startsWith('spec:') || t === 'talent') continue;
    const slug = CATEGORY_SLUGS.has(t) ? t : 'other';
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * Category chips worth showing for a dataset: only categories that occur in
 * at least one change, in the display order of CATEGORIES.
 * @param {{days: object[]}} data
 * @returns {{slug: string, label: string}[]}
 */
export function availableCategories(data) {
  const seen = new Set();
  for (const day of data.days || []) {
    for (const ch of day.changes || []) for (const c of categoryTagsOf(ch)) seen.add(c);
  }
  return CATEGORIES.filter((c) => seen.has(c.slug));
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

/**
 * Flatten one day's changes into "cards" with compact headings, so the page
 * never repeats a name (no "Druid" above "DRUID > RESTORATION").
 *
 * Each card has one or more sibling headings of the same level:
 *   - class card "Druid": a heading "Druid" for class-wide lines and one
 *     "Druid › Restoration" per tree that has lines. A class whose lines are
 *     all in one tree therefore shows only "Druid › Restoration".
 *   - general card per published category: "Dungeons" for ungrouped lines and
 *     "Dungeons › The Deadmines" per group (the group is inline, not nested).
 * Order: all-classes card, classes alphabetically, then general categories in
 * first-seen order (same as groupChanges).
 *
 * @param {object[]} changes changes of a single day
 * @returns {{count: number, cards: {kind: 'class'|'general', class: string|null,
 *   category: string|null, headings: {title: string[], spec: string|null,
 *   group: string|null, changes: object[]}[]}[]}}
 */
export function flattenSections(changes) {
  const g = groupChanges(changes);
  const cards = [];
  for (const sec of g.classSections) {
    const headings = [];
    if (sec.direct.length) headings.push({ title: [sec.label], spec: null, group: null, changes: sec.direct });
    for (const sp of sec.specs) headings.push({ title: [sec.label, sp.label], spec: sp.spec, group: null, changes: sp.changes });
    cards.push({ kind: 'class', class: sec.class, category: null, headings });
  }
  for (const cat of g.general) {
    const headings = cat.groups.map((grp) => ({
      title: grp.group ? [cat.category, grp.group] : [cat.category],
      spec: null,
      group: grp.group,
      changes: grp.changes,
    }));
    cards.push({ kind: 'general', class: null, category: cat.category, headings });
  }
  return { count: g.count, cards };
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
 * Create the default (unfiltered) UI state. `cats` is the list of ENABLED
 * category chips, or null meaning "all on" (the default). Using null rather
 * than a full list keeps categories that appear in later data switched on.
 * @returns {{cls: string, spec: string, q: string, cats: string[]|null, kind: 'all'|'hotfix'|'patch'}}
 */
export function defaultState() {
  return { cls: '', spec: '', q: '', cats: null, kind: 'all' };
}

/**
 * Is one category chip switched on in this state?
 * @param {{cats?: string[]|null}} state
 * @param {string} slug category tag
 * @returns {boolean}
 */
export function isCategoryOn(state, slug) {
  return !state.cats || state.cats.includes(slug);
}

/**
 * Canonical form of a category selection: null when every available category
 * is on (so "all" has exactly one representation), otherwise the enabled
 * slugs in chip order.
 * @param {string[]|null} cats enabled slugs, or null for all
 * @param {{slug: string}[]} available chips offered for the loaded data
 * @returns {string[]|null}
 */
export function normalizeCats(cats, available) {
  if (!cats) return null;
  const on = available.map((c) => c.slug).filter((s) => cats.includes(s));
  return on.length === available.length ? null : on;
}

/**
 * Flip one category chip and return the new canonical `cats` value.
 * @param {string[]|null} cats current selection (null = all on)
 * @param {string} slug chip to flip
 * @param {{slug: string}[]} available chips offered for the loaded data
 * @returns {string[]|null}
 */
export function toggleCategory(cats, slug, available) {
  const current = cats || available.map((c) => c.slug); // null = every chip on
  const next = current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
  return normalizeCats(next, available);
}

/**
 * Class/talent-tree filter for one change, driven by its tags
 * (docs/SCHEMA.md "Filter semantics used by the app").
 *  - no class chosen, or the change has no `class:` tag (an all-class line or
 *    a non-class line): it passes here (the category chips decide the latter)
 *  - class chosen: the change must be tagged `class:<cls>`; a line tagged with
 *    several classes matches each of them
 *  - tree also chosen: the change must be tagged `spec:<cls>/<tree>`, or have
 *    no `spec:<cls>/...` tag at all (a class-wide line applies to every tree)
 * @param {object} ch change
 * @param {{cls: string, spec: string}} state
 * @returns {boolean}
 */
export function matchesClassFilter(ch, state) {
  if (!state.cls) return true;
  const classes = classTagsOf(ch);
  if (!classes.length) return true;
  if (!classes.includes(state.cls)) return false;
  if (!state.spec) return true;
  const prefix = `spec:${state.cls}/`;
  const trees = effectiveTags(ch).filter((t) => t.startsWith(prefix));
  return !trees.length || trees.includes(prefix + state.spec);
}

/**
 * Class and category part of the filter for one change:
 *  - tagged with a class: the class/tree filter decides, the category chips
 *    are ignored ("class-tagged changes are always shown")
 *  - no class tag but category tags: shown when at least one of them is on
 *  - neither (an all-class line): always shown
 * Lines without a class tag keep their old behaviour of ignoring the class
 * choice, so picking Paladin still shows e.g. the Items and Quests lines
 * whose chips are on.
 * @param {object} ch
 * @param {object} state
 * @returns {boolean}
 */
export function matchesClassAndCategory(ch, state) {
  if (classTagsOf(ch).length) return matchesClassFilter(ch, state);
  const cats = categoryTagsOf(ch);
  if (!cats.length) return true; // all-class line
  return cats.some((c) => isCategoryOn(state, c));
}

/**
 * Full filter for one change: class/tree + category chips (all via tags) and
 * the search text when present.
 * @param {object} ch
 * @param {object} state
 * @returns {boolean}
 */
export function matchesState(ch, state) {
  return matchesClassAndCategory(ch, state) && matchesQuery(ch, state.q);
}

/**
 * Apply the state to the whole dataset and drop days with nothing left.
 * @param {{days: object[]}} data
 * @param {object} state
 * Days keep the order of the data (the data is already sorted); two days on
 * the same date (patch + hotfix) are separate entries.
 * @returns {{day: object, changes: object[]}[]} visible days (newest first, as in data)
 */
export function visibleDays(data, state) {
  const out = [];
  for (const day of data.days || []) {
    // Kind filter first: it is per day, so skip the day's lines entirely.
    if (!matchesKind(day, state.kind)) continue;
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
 * - Only changes passing the kind, class/spec filters and the category chips count
 *   (the search text itself is ignored here, otherwise the list would shrink
 *   to the thing already typed).
 * - Ranked by how many changes mention the subject (most frequent first),
 *   then alphabetically.
 * - Empty query: SKILL names only (type "spell"). Typing widens this to every
 *   subject (items too) and narrows by the text: prefix matches first, then
 *   substring matches, each group keeping the frequency order.
 *
 * @param {{days: object[]}} data
 * @param {object} state current UI state (cls/spec/cats/kind used)
 * @param {string} query text currently typed
 * @param {number} [limit] max suggestions
 * @returns {{name: string, icon: string, type: string, count: number}[]}
 */
export function buildSuggestions(data, state, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  const filterState = { ...state, q: '' };
  const tally = new Map(); // lower-cased name -> suggestion

  for (const day of data.days || []) {
    if (!matchesKind(day, state.kind)) continue; // hidden kind: no suggestions from it
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
 * Encode the state as a hash such as "#class=paladin&spec=retribution&q=judgement&cats=items,quests&kind=patch".
 * Default values are omitted (kind=all is never written); the default state
 * encodes to "" (no hash). `cats` lists the ENABLED categories and is written
 * only when not all are on: "cats=none" means every chip is off. The slugs
 * are written in chip order, so one selection has one URL.
 * @param {{cls: string, spec: string, q: string, cats?: string[]|null, kind?: string}} state
 * @returns {string} "" or a string starting with "#"
 */
export function encodeHash(state) {
  const p = new URLSearchParams();
  if (state.cls) p.set('class', state.cls);
  if (state.cls && state.spec) p.set('spec', state.spec);
  if (state.q) p.set('q', state.q);
  let catsValue = null;
  if (state.cats) {
    const known = CATEGORIES.map((c) => c.slug).filter((s) => state.cats.includes(s));
    catsValue = known.length ? known.join(',') : 'none';
  }
  const kind = sanitizeKindFilter(state.kind);
  if (kind !== 'all') p.set('kind', kind);
  // Commas are legal in a fragment and far more readable than %2C.
  const parts = [p.toString(), catsValue ? `cats=${catsValue}` : ''].filter(Boolean);
  const str = parts.join('&');
  return str ? `#${str}` : '';
}

/**
 * Parse the `cats` hash parameter (untrusted).
 *  - "none"            -> [] (every chip off)
 *  - "items,quests"    -> those known slugs
 *  - missing / junk    -> null (all on)
 * `generalOff` is the old `general=0` parameter, kept working: it means "no
 * category chips" when `cats` itself is absent.
 * @param {string|null} raw value of `cats`
 * @param {boolean} generalOff true when the hash had general=0
 * @returns {string[]|null}
 */
export function decodeCats(raw, generalOff = false) {
  if (raw == null) return generalOff ? [] : null;
  if (raw.trim().toLowerCase() === 'none') return [];
  const known = new Set(CATEGORIES.map((c) => c.slug));
  const slugs = raw.split(',').map((x) => x.trim().toLowerCase()).filter((x) => known.has(x));
  return slugs.length ? CATEGORIES.map((c) => c.slug).filter((x) => slugs.includes(x)) : null;
}

/**
 * Decode a location hash back into a state. Unknown/invalid values fall back
 * to defaults, so a hand-edited URL can never break the page. The legacy
 * `general=0` (the old "Show General changes" switch) decodes to `cats: []`.
 * An unknown `kind` value is ignored (treated as "all").
 * @param {string} hash e.g. "#class=paladin&q=judgement" (the "#" is optional)
 * @returns {{cls: string, spec: string, q: string, cats: string[]|null, kind: 'all'|'hotfix'|'patch'}}
 */
export function decodeHash(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const { cls, spec } = sanitizeSelection(p.get('class'), p.get('spec'));
  return {
    cls,
    spec,
    q: (p.get('q') || '').slice(0, 100),
    cats: decodeCats(p.get('cats'), p.get('general') === '0'),
    kind: sanitizeKindFilter(p.get('kind')),
  };
}

/* ======================= 8. Day kinds (schema v2) ======================= */

/** The kind filter values: everything, only hotfix days, only patch days. */
export const KIND_FILTERS = ['all', 'hotfix', 'patch'];

/**
 * Normalise a day's kind. Schema v2 says a missing `kind` means "hotfix"
 * (older data has none); anything unrecognised is treated the same way so a
 * malformed file can never create a third, unstyled kind.
 * @param {{kind?: unknown}} day
 * @returns {'hotfix'|'patch'}
 */
export function dayKind(day) {
  return day && day.kind === 'patch' ? 'patch' : 'hotfix';
}

/**
 * Stable identity of a day: date + kind. A patch and a hotfix can share a
 * date and are separate days, so the date alone is NOT unique. Use this for
 * DOM ids, maps and keys.
 * @param {{date: string, kind?: unknown}} day
 * @returns {string} e.g. "2026-11-13|patch"
 */
export function dayKey(day) {
  return `${day.date}|${dayKind(day)}`;
}

/**
 * Validate a kind-filter value from untrusted input (URL hash). Anything
 * other than "hotfix" / "patch" (including "all") becomes "all".
 * @param {unknown} v
 * @returns {'all'|'hotfix'|'patch'}
 */
export function sanitizeKindFilter(v) {
  return v === 'hotfix' || v === 'patch' ? v : 'all';
}

/**
 * Does a day pass the kind filter?
 * @param {object} day
 * @param {string} filter 'all' | 'hotfix' | 'patch'
 * @returns {boolean}
 */
export function matchesKind(day, filter) {
  return !filter || filter === 'all' || dayKind(day) === filter;
}

/* ======================= 9. Line decoration ======================= */

/**
 * The EXTRA tag chips to show under a line: everything the tags say that the
 * line's section heading does not already say.
 *  - one `class` chip per class tag other than the section's own class
 *  - a `talent` chip when the line is tagged `talent`
 *  - one `category` chip per category tag other than the section's own
 *    category (mapped from the published heading, e.g. "Quests and World"
 *    owns both quests and world)
 * `spec:` tags are never shown (the heading already names the tree).
 * @param {object} ch change
 * @returns {({type: 'class', slug: string, label: string, color: string|null}
 *   |{type: 'talent', label: string}
 *   |{type: 'category', slug: string, label: string})[]}
 */
export function extraTagsForLine(ch) {
  const out = [];
  for (const slug of classTagsOf(ch)) {
    if (slug === ch.class) continue; // the heading says it
    out.push({ type: 'class', slug, label: className(slug), color: classColor(slug) });
  }
  if (effectiveTags(ch).includes('talent')) out.push({ type: 'talent', label: 'Talent' });
  const own = categoryOfHeading(ch.category);
  for (const slug of categoryTagsOf(ch)) {
    if (own.includes(slug)) continue;
    const def = CATEGORIES.find((c) => c.slug === slug);
    out.push({ type: 'category', slug, label: def ? def.label : titleCase(slug) });
  }
  return out;
}

/** Most subject icons shown on one line; further subjects stay as name chips. */
export const MAX_ICONS = 4;

/**
 * Tooltip / alt text of one icon tile. The kind is spelled out so a talent is
 * not marked by the corner pip alone: "Oath of Light (talent)", or
 * "Oath of Light (Holy talent)" when the subject names its talent tree.
 * Only an explicit `verified: false` (the two icon sources disagree) adds a
 * quiet "unverified icon" hint; a missing flag adds nothing.
 * @param {object} sub subject
 * @returns {string}
 */
export function subjectTitle(sub) {
  let t = sub.name;
  if (sub.kind === 'talent') t += ` (${sub.tree ? `${titleCase(sub.tree)} ` : ''}talent)`;
  if (sub.verified === false) t += ' – unverified icon';
  return t;
}

/**
 * Split a line's subjects into the icon cluster and the overflow.
 * `slots` holds up to `max` subjects (in subject order) with the text for the
 * tile's title/alt (see subjectTitle). `more` holds the subjects beyond `max`.
 * @param {object} ch change
 * @param {number} [max]
 * @returns {{slots: {name: string, icon: string|undefined, talent: boolean, title: string}[], more: object[]}}
 */
export function iconSlots(ch, max = MAX_ICONS) {
  const subs = (ch.subjects || []).filter((s) => s && s.name);
  const slots = subs.slice(0, max).map((s) => ({
    name: s.name, icon: s.icon, talent: s.kind === 'talent', title: subjectTitle(s),
  }));
  return { slots, more: subs.slice(max) };
}
