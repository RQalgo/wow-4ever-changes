// scripts/tags.mjs
//
// PURPOSE
//   Computes the `tags` of every change (docs/SCHEMA.md, "Version 3"). Tags are
//   what the web app's filters use, so one line can belong to several classes
//   and several categories at once ("class:paladin", "class:rogue", "talent",
//   "spec:paladin/retribution", "items", "bugfix", ...).
//
// DESIGN
//   Pure functions, no I/O: `computeTags(change)` looks at the published
//   section (scope / category / class / spec / group), at the change text and
//   notes, and at the `subjects` found by scripts/icons.mjs; `addTags(days)`
//   applies it to every change. Everything is deterministic, so re-running the
//   pipeline over stored days (which update.mjs does on every run) yields the
//   same tags unless the rules or the subjects changed.
//
//   Output order (stable, so diffs of data/changes.json stay small):
//     class tags  - the published class first, then the others alphabetically
//     spec tags   - the published spec first, then others alphabetically
//     "talent"
//     category tags, alphabetically
//
// Node 22, ES modules, no dependencies.

/** The nine class slugs (docs/SCHEMA.md). */
const CLASSES = ['druid', 'hunter', 'mage', 'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior'];

// ---------------------------------------------------------------------------
// CATEGORY MAPPING FROM THE PUBLISHED CATEGORY HEADING
// ---------------------------------------------------------------------------

/**
 * Published category heading (lower-case, exact) -> category tags. Headings are
 * the ones seen in the real data; anything not listed here and not matched by
 * CATEGORY_PATTERNS becomes "other". "Classes" has no entry on purpose: a class
 * line is described by its class tags, not by a category.
 */
const CATEGORY_MAP = new Map([
  ['items', ['items']],
  ['quests', ['quests']],
  ['quests and world', ['quests', 'world']],
  ['dungeons', ['dungeons']],
  ['raids', ['dungeons']],
  ['professions', ['professions']],
  ['player versus player', ['pvp']],
  ['user interface', ['ui']],
  ['user interface and accessibility', ['ui']],
  ['cooldown manager', ['ui']],
  ['gamepad support', ['ui']],
  ['world', ['world']],
  ['enemies and npcs', ['world']],
  ['races', ['races']],
  ['racial abilities and traits', ['races']],
  ['stranglethorn fishing extravaganza', ['events']],
  ['legacy system', ['systems']],
  ['bugfixes', ['bugfix']],
  ['bug fixes', ['bugfix']],
  ['classes', []],
]);

/**
 * Pattern fallbacks for headings that are not in CATEGORY_MAP: any heading
 * containing "known issue" (the patch notes use several spellings such as
 * "Known Issues – New with this build"), and event-like names.
 */
const CATEGORY_PATTERNS = [
  [/known issue/i, 'known-issue'],
  [/extravaganza|festival|\bevent\b/i, 'events'],
];

// ---------------------------------------------------------------------------
// TEXT RULES (applied to text + notes; keep them conservative)
// ---------------------------------------------------------------------------

/** Quest-name quotes only count as quest mentions next to quest vocabulary. */
const QUOTE_RE = /[“"][^”"]{2,80}[”"]/;
const QUEST_CONTEXT_RE = /\b(?:complet\w*|objectives?|turn(?:ed|ing|s)? in|rewards?|accept\w*|NPC)\b/i;

/** Names of the dungeons / raids of WoW: Forever seen so far (and Classic ones). */
const DUNGEON_NAMES = String.raw`deadmines|wailing caverns|shadowfang keep|blackfathom deeps|stockade|gnomeregan|razorfen (?:kraul|downs)|scarlet monastery|uldaman|zul['’]farrak|maraudon|sunken temple|blackrock (?:depths|spire)|stratholme|scholomance|dire maul|molten core|onyxia|blackwing lair|zul['’]gurub|ahn['’]qiraj|naxxramas|alcaz prison|drowned city|shaper['’]s terrace`;

/**
 * The text-rule table: [tag, regex]. A change gets the tag when the regex
 * matches its text or any note. One table, one place to tune.
 *  - word boundaries everywhere; case-insensitive except "UI";
 *  - "raid" is skipped in the common class-text phrases ("party or raid",
 *    "raid members", "your raid", ...), where it means the player group.
 */
const TEXT_RULES = [
  ['quests', /\bquests?\b/i],
  ['dungeons', /\b(?:dungeons?|instances?)\b/i],
  ['dungeons', /(?<!(?:party or|your|the|a|in|of|and|until) )\braids?\b(?!\s+(?:members?|frames?|groups?|party|wide|buffs?|leaders?|markers?|warnings?|chat|healing|utility|and party))/i],
  ['dungeons', new RegExp(String.raw`\b(?:${DUNGEON_NAMES})\b`, 'i')],
  ['pvp', /\b(?:battlegrounds?|pvp|honor|arena|warsong gulch|alterac valley|arathi basin)\b/i],
  ['professions', /\b(?:alchemy|blacksmithing|cooking|enchanting|engineering|first aid|fishing|herbalism|leatherworking|mining|skinning|tailoring|professions?)\b/i],
  ['ui', /\b(?:cooldown manager|nameplates?|action ?bars?|tooltips?|user interface)\b/i],
  ['ui', /\bUI\b/], // case-sensitive: "ui" is not a word, but keep "UI" distinct
  ['events', /\b(?:extravaganza|festival|darkmoon faire)\b/i],
  ['systems', /\blegacy (?:perks?|challenges?|system)\b/i],
];

/** Lines that start like a bug fix get "bugfix" in addition to their other tags. */
// An optional "Zone Name - " prefix is skipped ("Durotar - Fixed an issue ...").
const BUGFIX_START_RE = /^\s*(?:[^.:]{1,40}?\s[-–—]\s+)?(?:fixed|resolved|corrected|addressed)\b/i;

/** "talent" text rule: the word, or a talent row ("Row 4"). */
const TALENT_TEXT_RE = /\btalents?\b|\bRow \d/i;

// ---------------------------------------------------------------------------
// CLASS MENTIONS IN TEXT
// ---------------------------------------------------------------------------

/**
 * Capitalised words that may sit next to a class word without making it part of
 * a longer name: function words capitalised only because they start a sentence.
 */
const NEIGHBOUR_OK = new Set([
  'the', 'a', 'an', 'all', 'each', 'every', 'any', 'some', 'this', 'that', 'these', 'those',
  'for', 'when', 'if', 'with', 'now', 'only', 'also', 'new', 'fixed', 'resolved', 'updated',
  'adjusted', 'corrected', 'changed', 'increased', 'decreased', 'reduced', 'improved', 'removed',
  'added', 'and', 'or', 'to', 'in', 'on', 'of', 'as', 'at', 'by', 'from', 'it', 'its', 'their',
  'while', 'after', 'before', 'once', 'there', 'where', 'which', 'players', 'developers',
  // talent-tree words and other class words ("Retribution Paladin", "Rogue and Warrior")
  'arcane', 'fire', 'frost', 'holy', 'protection', 'retribution', 'discipline', 'shadow',
  'assassination', 'combat', 'subtlety', 'elemental', 'enhancement', 'restoration', 'balance',
  'feral', 'affliction', 'demonology', 'destruction', 'arms', 'fury', 'survival', 'marksmanship',
  'beast', 'mastery',
  ...CLASSES,
]);

/**
 * Classes mentioned in a piece of text as class words. A mention counts when
 * the word is capitalised, or plural in lower case ("rogues"), and is NOT part
 * of a longer capitalised name: "Novice Warriors" or "Priest of the Sun" are
 * NPC names, "Shaman quest reward" and "Paladin’s" are the class. Quoted text
 * (quest names) is ignored.
 *
 * @param {string} text
 * @returns {Set<string>} class slugs
 */
export function classMentions(text) {
  const found = new Set();
  const s = String(text ?? '')
    .replace(/[“"][^”"]*[”"]/g, ' ')
    .replace(/\([^)]*\)/g, ' ');
  // Singular or plural class word, optional possessive ("Paladin’s", "rogues'").
  const re = new RegExp(String.raw`\b(${CLASSES.join('|')})(s?)(?:['’]s?)?(?![\p{L}\p{N}])`, 'giu');
  for (const m of s.matchAll(re)) {
    const word = m[1];
    const plural = m[2] === 's' || /s['’]$/.test(m[0]);
    const capitalised = /^\p{Lu}/u.test(word);
    if (!capitalised && !plural) continue; // "a rogue" in prose: not a class mention
    // Neighbouring words: a capitalised neighbour that is not a function word
    // makes this part of a name ("Novice Warriors"); a following "of" does too.
    const before = /([\p{L}'’-]+)\s+$/u.exec(s.slice(0, m.index));
    const after = /^\s+([\p{L}'’-]+)(?:\s+([\p{L}'’-]+))?/u.exec(s.slice(m.index + m[0].length));
    const capNeighbour = (w) => w && /^\p{Lu}/u.test(w) && !NEIGHBOUR_OK.has(w.toLowerCase());
    if (capNeighbour(before?.[1]) || capNeighbour(after?.[1])) continue;
    if (after && after[1].toLowerCase() === 'of' && after[2] && /^\p{Lu}|^the$/u.test(after[2])) continue;
    found.add(word.toLowerCase());
  }
  return found;
}

// ---------------------------------------------------------------------------
// computeTags / addTags
// ---------------------------------------------------------------------------

/**
 * Category tags for the published category heading (see CATEGORY_MAP).
 * Returns null for a heading that maps to nothing known (caller adds "other").
 * @param {string|null|undefined} category
 * @returns {string[]|null}
 */
function categoryTagsFor(category) {
  const key = String(category ?? '').trim().toLowerCase();
  if (CATEGORY_MAP.has(key)) return CATEGORY_MAP.get(key);
  const tags = CATEGORY_PATTERNS.filter(([re]) => re.test(key)).map(([, tag]) => tag);
  return tags.length ? tags : null;
}

/**
 * Compute the tags of one change (vocabulary and rules: docs/SCHEMA.md v3).
 *
 *  - class:<slug>   published class; class of every talent / ability subject;
 *                   class words in text / notes (classMentions)
 *  - spec:<c>/<t>   published spec; every talent subject with class + tree
 *  - talent         a talent subject, the word "talent", or "Row N"
 *  - categories     from the published category and the text rules; "other"
 *                   only when nothing more specific applies and the line is not
 *                   already described by a class tag
 *
 * Every change gets at least one tag.
 *
 * @param {object} change
 * @returns {string[]} tags in deterministic order
 */
export function computeTags(change) {
  const subjects = Array.isArray(change.subjects) ? change.subjects : [];
  const notes = Array.isArray(change.notes) ? change.notes : [];
  const bodies = [change.text ?? '', ...notes];

  // --- classes ---
  const classes = new Set();
  const published = change.class && CLASSES.includes(change.class) ? change.class : null;
  for (const s of subjects) {
    if ((s.kind === 'talent' || s.kind === 'ability') && CLASSES.includes(s.class)) classes.add(s.class);
  }
  for (const b of bodies) for (const c of classMentions(b)) classes.add(c);
  if (published) classes.delete(published);
  const classTags = [
    ...(published ? [`class:${published}`] : []),
    ...[...classes].sort().map((c) => `class:${c}`),
  ];

  // --- specs ---
  const specs = new Set();
  const publishedSpec = published && change.spec ? `spec:${published}/${change.spec}` : null;
  for (const s of subjects) {
    if (s.kind === 'talent' && CLASSES.includes(s.class) && s.tree) specs.add(`spec:${s.class}/${s.tree}`);
  }
  if (publishedSpec) specs.delete(publishedSpec);
  const specTags = [...(publishedSpec ? [publishedSpec] : []), ...[...specs].sort()];

  // --- talent ---
  const isTalent = subjects.some((s) => s.kind === 'talent') || bodies.some((b) => TALENT_TEXT_RE.test(b));

  // --- categories ---
  const cats = new Set();
  const published_ = categoryTagsFor(change.category);
  (published_ ?? []).forEach((t) => cats.add(t));
  if (subjects.some((s) => s.type === 'item')) cats.add('items');
  for (const [tag, re] of TEXT_RULES) if (bodies.some((b) => re.test(b))) cats.add(tag);
  if (QUOTE_RE.test(change.text ?? '') && QUEST_CONTEXT_RE.test(change.text ?? '')) cats.add('quests');
  if (BUGFIX_START_RE.test(change.text ?? '')) cats.add('bugfix');
  // A dungeon named in the published sub-heading ("The Deadmines") is a dungeon line.
  if (change.group && new RegExp(String.raw`\b(?:${DUNGEON_NAMES})\b`, 'i').test(change.group)) cats.add('dungeons');
  // "other" is the catch-all: only for an unknown heading with nothing more
  // specific, or a line with no other tag at all (e.g. an all-class line).
  if (published_ === null && cats.size === 0) cats.add('other');
  const hasOtherTag = classTags.length || specTags.length || isTalent || cats.size;
  if (!hasOtherTag) cats.add('other');

  return [...classTags, ...specTags, ...(isTalent ? ['talent'] : []), ...[...cats].sort()];
}

/**
 * Set `tags` on every change of every day (see computeTags). Mutates and
 * returns `days`, like addSubjects.
 * @param {{ changes?: object[] }[]} days
 * @returns {object[]} the same `days`
 */
export function addTags(days) {
  for (const day of days) {
    for (const change of day.changes ?? []) change.tags = computeTags(change);
  }
  return days;
}
