// scripts/icons.mjs
//
// PURPOSE
//   Icon / subject resolver for the "WoW: Forever changes" pipeline (step 3 in
//   docs/PLAN.md). For every change in the days structure described in
//   docs/SCHEMA.md (version 3) it finds the skills, talents and items named in
//   `text` and then in `notes`, and fills `change.subjects` with
//   `{ name, type, kind, class, tree, icon, source, verified? }` entries
//   (at most 8). The first subject supplies the line's icon in the web app;
//   with no subjects the app falls back to a class / category icon.
//
// DESIGN
//   1. extractCandidateGroups / extractCandidates - purely textual heuristics.
//      Runs of Capitalised Words that look like proper names, minus quotes,
//      parentheses, rank suffixes, zone prefixes, patch-note lead-ins ("New
//      Talent", "Added:"), "Name: description" tails, possessive tails, trailing
//      "Removed" / "in Row 4" and a stoplist of filler / generic terms. "A and B"
//      lists become separate names.
//   2. lookupName(name, ...)  - asks Wowhead's search-suggestions endpoint and
//      accepts only an exact (case-insensitive) Spell or Item match with an
//      icon; several matches are ranked (see pickResult). Result:
//      `{ name, type, kind, class, icon }`, kind/class from the breadcrumb.
//   3. addSubjects(days, ...) - glues them together. SOURCE ORDER per name:
//      overrides ("override"), then the optional game-client index `gameIndex`
//      ("client": primary, free, knows talents / trees), then Wowhead
//      ("wowhead": budgeted fallback and cross-check). When a client-resolved
//      name also has a Wowhead answer, `verified` says whether the icons agree.
//
//   Everything that touches the network goes through an injectable `fetchImpl`,
//   so the unit tests use stubs and never need the internet.
//
// CACHE  (data/icon-cache.json)
//   Keyed by the lower-cased name (curly apostrophes normalised to straight).
//   A hit is stored as `{ name, type, kind, class, icon }`, a definitive miss as
//   `null`, so nothing is ever looked up twice. Network / HTTP / JSON errors are
//   NOT cached (the answer is "unknown for now"; the next run tries again).
//   Entries written before v3 are `{ name, type, icon }`: they keep working
//   (kind "spell"/"item", class null); old SPELL hits are re-looked-up when
//   budget allows and rewritten, old ITEM hits need no network call.
//
// OVERRIDES  (data/icon-overrides.json)  -- hand-edited
//   `{ "<lower-cased name>": { name, type, icon, kind?, class?, tree? } | null }`.
//   `kind` ("talent" | "ability" | "spell" | "item"), `class` (slug) and `tree`
//   (talent-tree slug) are optional; kind defaults to "spell" / "item" by type.
//   An override WINS over the client index, the cache and the network. Use an
//   entry to fix a wrong icon, to supply one nobody lists, or set the value to
//   `null` to stop a name from ever being resolved (a false positive).
//   The file is never written by this script. Plain JSON has no comments, so
//   this header is the documentation.
//
// ALIASES  (data/name-aliases.json)  -- hand-edited
//   `{ "<lower-cased name as written in the notes>": "Canonical Name" }`, e.g.
//   `{ "unsealed fury": "Unsealed Wrath" }`: Blizzard's notes sometimes use a
//   different name than the game data. The canonical name is resolved through
//   the normal order (override, client index, Wowhead); the subject keeps the
//   written name in `name` and gets `alias: "<canonical name>"`. If the target
//   cannot be resolved the written name is tried as usual. A missing or corrupt
//   file means no aliases (one log line).
//
// POLITENESS
//   Requests are strictly sequential, separated by `delayMs`, carry an honest
//   User-Agent, time out after 15 s, and are capped at `maxLookups` new network
//   calls per run (250 by default, 1.5 s apart). After 5 consecutive failures the run stops calling the network.
//   The resolver never throws because of the network; the site simply falls back
//   to class icons for lines that stay unresolved.
//
// Node 22, ES modules, no dependencies.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Wowhead search-suggestions endpoint (query string is appended). */
const SUGGEST_URL = 'https://www.wowhead.com/forever/search/suggestions-template?q=';

/** Honest User-Agent: identifies this project, does not impersonate a browser. */
const USER_AGENT = 'wow-4ever-changes/0.1 (+https://github.com/RQalgo/wow-4ever-changes)';

/** Per-request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Stop making network calls after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Maximum number of candidate names kept per change line (or note). */
const MAX_CANDIDATES = 6;

/** Maximum number of subjects (and candidate names) per change, text plus notes. */
const MAX_SUBJECTS = 8;

/** Per run, at most this many Wowhead lookups are spent cross-checking client-resolved names. */
const MAX_VERIFY_LOOKUPS = 100;

// ---------------------------------------------------------------------------
// STOPLISTS  (all entries are compared lower-cased; keep them in this block)
// ---------------------------------------------------------------------------

/**
 * FILLER_WORDS: sentence-starter verbs / determiners / connectives. They are
 * capitalised only because they begin a sentence, so they are stripped from the
 * LEFT edge of a run ("Fixed Consecration" -> "Consecration"). Deliberately NOT
 * generic: words like "Unsealed" that can start a real spell name stay out.
 */
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'several', 'certain',
  'all', 'any', 'each', 'every', 'both', 'now', 'also', 'only', 'still', 'no',
  'with', 'when', 'on', 'in', 'of', 'for', 'to', 'if', 'after', 'before', 'while',
  'once', 'as', 'at', 'by', 'from', 'it', 'its', 'their', 'there', 'where', 'which',
  'fixed', 'fixes', 'fix', 'resolved', 'updated', 'adjusted', 'corrected', 'changed',
  'increased', 'decreased', 'reduced', 'improved', 'removed', 'added', 'reverted',
  'restored', 'enabled', 'disabled', 'made', 'reworked', 'tuned', 'using',
  'players', 'player', 'enemies', 'creatures', 'mobs', 'monsters', 'bosses', 'note',
  // Patch-note verbs / adverbs that start a sentence or follow a "Name:" prefix
  // ("Reckoning: Replaced ...", "Additionally, ..."). Added with the v3 rules.
  'replaced', 'replaces', 'gives', 'reduces', 'additionally', 'addressed', 'completing',
  'deployed', 'does', 'beyond', 'renamed', 'moved', 'new',
  // Pronouns / connectives / gerunds capitalised at a sentence start (found by
  // the local dry check over data/changes.json).
  'they', 'you', 'we', "we're", "we've", 'previously', 'me', 'however', 'until', 'can', 'will', 'should', 'additional',
  'defeating', 'switching', 'although', 'because', 'since', 'so', 'but', 'then', 'what', 'how',
]);

/**
 * CLASS_AND_SPEC_WORDS: class names (singular and plural) and talent-tree names.
 * They name the filter the line already sits under, never a skill.
 */
const CLASS_AND_SPEC_WORDS = [
  'druid', 'druids', 'hunter', 'hunters', 'mage', 'mages', 'paladin', 'paladins',
  'priest', 'priests', 'rogue', 'rogues', 'shaman', 'shamans', 'warlock', 'warlocks',
  'warrior', 'warriors',
  'balance', 'feral', 'restoration', 'beast mastery', 'marksmanship', 'survival',
  'arcane', 'fire', 'frost', 'holy', 'protection', 'retribution', 'discipline',
  'shadow', 'assassination', 'combat', 'subtlety', 'elemental', 'enhancement',
  'affliction', 'demonology', 'destruction', 'arms', 'fury',
];

/**
 * GENERIC_TERMS: game vocabulary that is capitalised in patch notes but is not a
 * skill or an item: stats, schools, factions, armour / weapon types, UI words.
 * A run made ONLY of these is dropped. Multi-word entries are matched as phrases.
 */
const GENERIC_TERMS = [
  // stats and combat vocabulary
  'mana', 'spirit', 'strength', 'intellect', 'agility', 'stamina', 'hit', 'crit',
  'haste', 'armor', 'resist', 'spell power', 'mp5', 'hp', 'dps', 'aoe', 'dot', 'hot',
  'gcd', 'pve', 'pvp', 'ai', 'cc', 'dr',
  // bind types and UI / meta terms
  'bind-on-pickup', 'bind-on-equip', 'cooldown manager', 'legacy perk',
  'legacy challenge', 'developers', 'developer', 'xp', 'ui', 'npc', 'npcs',
  'level', 'rank', 'tier', 'patch', 'season', 'phase', 'hardcore', 'classic',
  // attack types and schools
  'melee', 'ranged', 'ranged attack', 'melee attack', 'arcane', 'nature', 'holy',
  'fire', 'frost', 'shadow', 'physical',
  // v3 stoplist: row / stat / resource / status vocabulary that patch notes
  // capitalise but that is never a skill. Multi-word entries are whole phrases.
  'row', 'base', 'base mana', 'spell damage', 'attack power', 'ranged attack power',
  'attack speed', 'combo point', 'combo points', 'rage', 'energy', 'cooldown', 'duration',
  'damage', 'experience', 'icon', 'active', 'primary', 'master', 'beta', 'vanilla wow',
  'classic era', 'diminishing returns', 'main hand', 'off hand', 'health', 'threat',
  'block', 'dodge', 'dodging', 'stun', 'charm', 'talent', 'talents', 'new talent',
  'spell', 'power', 'coefficient',
  // UI / system vocabulary and one-word junk found by the dry check
  'wow', 'forever', 'gamepad', 'gamepad action bar', 'edit mode', 'options', 'lua', 'raid',
  'honor', 'vanilla', 'pet', 'pets', 'healing', 'quick', 'dead', 'personal resource display',
  'nameplate', 'nameplates', 'quest log', 'quest types', 'quest tracker', 'specific macros',
  'macros', 'quest', 'text', 'character', 'character info', 'target frame', 'number', 'weapon',
  'equipment manager', 'critical strike', 'critical strikes', 'world of warcraft',
  // plural category nouns that start sentences in developer notes ("Abilities like ...")
  'spells', 'abilities', 'attacks', 'effects', 'strikes', 'auras', 'totems', 'seals', 'judgements',
  // factions
  'alliance', 'horde',
  // armour and weapon types
  'mace', 'sword', 'axe', 'dagger', 'staff', 'polearm', 'bow', 'gun', 'crossbow',
  'wand', 'shield', 'mail', 'leather', 'cloth', 'plate',
];

/** Lower-case words that may join two capitalised words inside one name. */
const CONNECTORS = new Set(['of', 'the', 'and', 'to', 'in', 'for']);

/**
 * Connectors that more often join two SEPARATE things than sit inside one name
 * ("Sap in Warsong Gulch"). Used only when falling back after a full-phrase miss.
 */
const WEAK_CONNECTORS = new Set(['in', 'for', 'to', 'and']);

const CLASS_AND_SPEC_SET = new Set(CLASS_AND_SPEC_WORDS);
const GENERIC_SET = new Set(GENERIC_TERMS);

// ---------------------------------------------------------------------------
// CANDIDATE EXTRACTION
// ---------------------------------------------------------------------------

/**
 * Normalise a name for comparison and cache keys: curly apostrophes become
 * straight ones, whitespace is collapsed and the result is lower-cased.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Remove everything from a change line that must never yield a candidate:
 *   - quoted text (quest names), curly or straight double quotes;
 *   - parenthesised text such as "(was 3.3%)";
 *   - rank suffixes ("Rank 1");
 *   - a leading zone prefix "Zone Name - rest" (keeps only "rest").
 * Removed spans are replaced by a space so neighbouring words cannot fuse.
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  let s = String(text ?? '');
  s = s.replace(/“[^”]*”/g, ' '); // “quest name”
  s = s.replace(/"[^"]*"/g, ' ');                // "quest name"
  s = s.replace(/\([^)]*\)/g, ' ');              // (was 3.3%)
  s = s.replace(/\bRank\s+\d+\b/g, ' ');         // Siphon Life Rank 1
  s = s.trim();
  // Zone prefix: one or more Capitalised words (with of/the/and), then a SPACED
  // dash. A hyphen inside a word ("Bind-on-Pickup") has no spaces so it is safe.
  const zone = /^[A-Z][\w'’]*(?:\s+(?:of|the|and|[A-Z][\w'’]*))*\s+[-–—]\s+/;
  s = s.replace(zone, '');
  return s;
}

/**
 * One capitalised word: ASCII capital first, then letters / digits / apostrophes
 * (straight or curly) / hyphens, so "Zul'Farrak", "Mind-numbing" and "Eye’s"
 * are single tokens.
 */
const WORD = String.raw`[A-Z][\p{L}\p{N}'’-]*`;

/**
 * A "run" is a Capitalised word followed by any number of further Capitalised
 * words. Between two words we allow either ": " ("Shadow Word: Pain") or
 * whitespace plus optional lower-case connectors ("Judgement of Command").
 * Punctuation such as commas and full stops ends a run.
 */
const RUN_RE = new RegExp(
  `${WORD}(?:(?::\\s+|\\s+(?:(?:${[...CONNECTORS].join('|')})\\s+)*)${WORD})*`,
  'gu',
);

/**
 * True when a token (colon stripped, lower-cased) is a single generic term.
 * @param {string} token
 * @returns {boolean}
 */
function isGenericToken(token) {
  const t = normalizeName(token).replace(/:$/, '');
  return GENERIC_SET.has(t) || CLASS_AND_SPEC_SET.has(t);
}

/**
 * Multi-word phrases made ONLY of generic vocabulary that are nevertheless real
 * skills ("Holy Shield", "Mana Shield"). Without this list the all-generic rule
 * below would drop them. Grown from the real data; names are lower-case.
 */
const ALLOWED_GENERIC_NAMES = new Set([
  'holy shield', 'mana shield', 'shield block', 'arcane power', 'frost armor',
  'ice armor', 'fire shield', 'fire resistance', 'frost resistance',
  'shadow resistance', 'nature resistance', 'holy power', 'the quick and the dead', 'quick and the dead',
]);

/**
 * TRAILING_STATUS: words patch notes append to a name to describe what happened
 * to it ("Instrument of Law Removed", "Oath of Light in Row 4"). Stripped from
 * the RIGHT edge of a run, together with any connector left dangling.
 */
const TRAILING_STATUS = new Set(['removed', 'added', 'renamed', 'moved', 'changed', 'replaced', 'row']);

/**
 * TRAILING_NOISE: capitalised stat words that follow a name ("Shield
 * Specialization Mana restored ..."). Stripped from the right edge, but only
 * when something else remains. Deliberately excludes Rage / Energy / Shield /
 * Armor, which end real names ("Berserker Rage", "Holy Shield").
 */
const TRAILING_NOISE = new Set([
  'mana', 'damage', 'cooldown', 'duration', 'threat', 'health', 'healing', 'cost',
  'range', 'experience', 'coefficient', 'base',
]);

/**
 * PLURAL_CATEGORY_NOUNS: a single capitalised word followed by one of these in
 * lower case names a CATEGORY, not a skill ("your Seal spells" -> not "Seal").
 */
const PLURAL_CATEGORY_RE = /^\s+(?:spells|abilities|attacks|effects|talents|strikes|auras|totems|shouts|curses|stings|traps|blessings|seals|judgements)\b/;

/**
 * True when the whole phrase is not a candidate: it is itself a generic term
 * ("Cooldown Manager", "Spell Power") or every word is generic ("Fire Mage"),
 * unless it is on the ALLOWED_GENERIC_NAMES list.
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isGenericPhrase(tokens) {
  const words = tokens.filter((t) => !CONNECTORS.has(t)).map((t) => normalizeName(t).replace(/:/g, ''));
  const phrase = words.join(' ');
  if (ALLOWED_GENERIC_NAMES.has(normalizeName(tokens.join(' ')).replace(/:/g, ''))) return false;
  if (GENERIC_SET.has(phrase) || CLASS_AND_SPEC_SET.has(phrase)) return true;
  // Lower-case connectors are ignored so "Mace and Sword" counts as all-generic.
  // Dynamic programme: can the words be covered by generic words / phrases
  // ("Base Mana" + "Attack Power" + "Combo Points")?
  const covered = new Array(words.length + 1).fill(false);
  covered[0] = true;
  for (let i = 0; i < words.length; i++) {
    if (!covered[i]) continue;
    for (let j = i + 1; j <= words.length; j++) {
      const piece = words.slice(i, j).join(' ');
      if (GENERIC_SET.has(piece) || CLASS_AND_SPEC_SET.has(piece)) covered[j] = true;
    }
  }
  return words.length > 0 && covered[words.length];
}

/**
 * True when a token is "noise" as the first word AFTER a colon or possessive:
 * filler ("Now"), generic ("Base", "Holy", "Threat") or a status word
 * ("Renamed", "Removed"). Used to decide whether "Name: Word" is one name
 * ("Shadow Word: Pain") or a heading followed by a sentence ("Reckoning: Now").
 * @param {string} token
 * @returns {boolean}
 */
function isNoiseToken(token) {
  const t = normalizeName(token).replace(/:$/, '');
  return FILLER_WORDS.has(t) || TRAILING_STATUS.has(t) || isGenericToken(token);
}

/**
 * Split a token list at the first "Heading:" colon when what follows is noise.
 * "Reckoning: Now" -> ["Reckoning:"], ["Now"]; "Fireball: Renamed Accelerant"
 * -> ["Fireball:"], ["Renamed", "Accelerant"]. When the word after the colon is
 * real ("Shadow Word: Pain") or the heading ends in "Word:" ("Power Word:
 * Shield") the list stays whole.
 * @param {string[]} tokens
 * @returns {string[][]} one or more token lists
 */
function splitAtColon(tokens) {
  const i = tokens.findIndex((t, k) => k < tokens.length - 1 && t.endsWith(':'));
  if (i < 0) return [tokens];
  const head = tokens.slice(0, i + 1);
  const tail = tokens.slice(i + 1);
  if (/^word:$/i.test(head[head.length - 1])) return [tokens]; // Power/Shadow Word: X
  if (!isNoiseToken(tail[0])) return [tokens];
  return [head, ...splitAtColon(tail)];
}

/**
 * Split a token list after every possessive that is followed by noise:
 * "Consecration’s Spell Power Coefficient" -> ["Consecration’s"],
 * ["Spell", "Power", "Coefficient"]. A possessive followed by a real word is
 * kept ("Nature's Grasp", "Hunter's Mark").
 * @param {string[]} tokens
 * @returns {string[][]}
 */
function splitAtPossessive(tokens) {
  const groups = [];
  let current = [];
  tokens.forEach((tok, i) => {
    current.push(tok);
    if (/['’]s:?$/i.test(tok)) {
      const next = tokens.slice(i + 1).find((t) => !CONNECTORS.has(t));
      if (next !== undefined && isNoiseToken(next)) { groups.push(current); current = []; }
    }
  });
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Clean one token list into a name (string) or null when nothing usable is
 * left: strips leading filler ("Fixed", "The"; but "Improved Seal of Fury"
 * keeps its "Improved"), trailing status / noise / dangling connectors, and a
 * trailing possessive or colon; drops generic phrases.
 * @param {string[]} tokens
 * @returns {string[]|null} cleaned tokens, or null
 */
function cleanTokens(tokens) {
  let g = [...tokens];
  // Leading filler. "Improved" is a real name prefix when more words follow.
  while (g.length) {
    const first = normalizeName(g[0]).replace(/:$/, '');
    if (first === 'improved' && g.length > 1) break;
    if (!(FILLER_WORDS.has(first) || CONNECTORS.has(g[0]))) break;
    g = g.slice(1);
  }
  // Trailing status words, noise nouns and connectors left dangling by them.
  while (g.length) {
    const last = normalizeName(g[g.length - 1]).replace(/:$/, '');
    const strip = CONNECTORS.has(last) || TRAILING_STATUS.has(last)
      || (g.length > 1 && TRAILING_NOISE.has(last));
    if (!strip) break;
    g = g.slice(0, -1);
  }
  if (!g.length) return null;
  g[g.length - 1] = g[g.length - 1].replace(/['’]s$/i, '').replace(/:$/, '').replace(/['’]$/, ''); // "Intensity’" from a closing quote
  if (!g[g.length - 1]) return null;
  if (g.some((t) => /-(?:based|era)$/i.test(t))) return null; // "Fire-based and Frost-based": prose, not a name
  return isGenericPhrase(g) ? null : g;
}

/**
 * @typedef {{ whole: string|null, parts: string[] }} CandidateGroup
 *   `parts` are the names to look up (in order). `whole` is set only for
 *   "A and B" with one word on each side ("Slice and Dice"): it may be a real
 *   name, so lookup tries it first and uses `parts` only when it misses.
 */

/**
 * Turn one regex run into candidate groups: split at noise colons and
 * possessives, clean each piece, then split "A and B" lists into parts.
 * @param {string} run
 * @returns {CandidateGroup[]}
 */
function groupsFromRun(run) {
  const groups = [];
  const tokens = run.split(/\s+/);
  for (const piece of splitAtColon(tokens)) {
    for (const sub of splitAtPossessive(piece)) {
      // "A and B" -> sides; every other connector stays inside a name.
      const sides = [[]];
      for (const t of sub) { if (t === 'and') sides.push([]); else sides[sides.length - 1].push(t); }
      const parts = sides.map((side) => cleanTokens(side)).filter(Boolean).map((g) => g.join(' '));
      // "Slice and Dice", "Shadow and Flame": one word per side may be ONE real
      // name, so keep the whole as a first try (even if a side is generic).
      let whole = null;
      if (sides.length === 2 && sides.every((sd) => sd.filter((t) => !CONNECTORS.has(t.toLowerCase())).length === 1) && !isGenericPhrase(sub)) {
        whole = sub.join(' ').replace(/:$/, '');
      }
      if (!parts.length && !whole) continue;
      groups.push({ whole, parts });
    }
  }
  return groups;
}

/**
 * Prepare one change line (or note) for extraction: remove quoted text,
 * parentheses, rank suffixes and zone prefixes (cleanText), strip the
 * "Developers' notes:" lead-in of notes and the "New Talent" / "Added:" /
 * "New:" lead-ins of patch-note lines.
 * @param {string} text
 * @returns {{ text: string, talentLine: boolean }} `talentLine` is true for a
 *   "New Talent ..." line, whose prose after the name is not scanned for names
 */
function prepareLine(text) {
  let s = cleanText(text);
  s = s.replace(/^Developers?['’]?s?['’]?\s+notes?\s*:\s*/i, '');
  let talentLine = false;
  const lead = /^(?:New Talent\b\s*:?|Added\s*:|New\s*:)\s*/i;
  const m = lead.exec(s);
  if (m) { talentLine = /^new talent/i.test(m[0]); s = s.slice(m[0].length); }
  return { text: s, talentLine };
}

/**
 * Find the candidate groups of one change line or note (see CandidateGroup).
 * Order of appearance, de-duplicated case-insensitively, capped at
 * MAX_CANDIDATES names in total.
 *
 * @param {string} text
 * @param {{ classSlug?: string|null }} [opts]  accepted for API symmetry
 * @returns {CandidateGroup[]}
 */
export function extractCandidateGroups(text, { classSlug } = {}) {
  void classSlug; // reserved: every class name is already in the stoplist
  const { text: cleaned, talentLine } = prepareLine(text);
  const seen = new Set();
  const out = [];
  let count = 0;
  for (const m of cleaned.matchAll(RUN_RE)) {
    // A single capitalised word before a plural category noun ("your Seal
    // spells") names a category, not a skill.
    const after = cleaned.slice(m.index + m[0].length);
    if (!/\s/.test(m[0]) && PLURAL_CATEGORY_RE.test(after)) continue;
    for (const group of groupsFromRun(m[0])) {
      const parts = group.parts.filter((n) => !seen.has(normalizeName(n)));
      if (!parts.length && !group.whole) continue;
      parts.forEach((n) => seen.add(normalizeName(n)));
      out.push({ whole: group.whole && parts.length === group.parts.length ? group.whole : null, parts });
      count += parts.length;
      if (count >= MAX_CANDIDATES) return trimGroups(out);
    }
    // "New Talent X in Row 4. <prose>": only the name itself is a candidate.
    if (talentLine && out.length) break;
  }
  return trimGroups(out);
}

/**
 * Enforce MAX_CANDIDATES on the flattened part count (the last group may be cut).
 * @param {CandidateGroup[]} groups
 * @returns {CandidateGroup[]}
 */
function trimGroups(groups) {
  let left = MAX_CANDIDATES;
  const out = [];
  for (const g of groups) {
    if (left <= 0) break;
    const parts = g.parts.slice(0, left);
    left -= parts.length;
    out.push({ whole: parts.length === g.parts.length ? g.whole : null, parts });
  }
  return out;
}

/**
 * Find the skill / item names mentioned in one change line.
 *
 * Heuristic: runs of Capitalised Words (with lower-case connectors such as
 * "of"/"the") that survive the stoplists, after removing quotes, parentheses,
 * rank suffixes, zone prefixes and the patch-note lead-ins ("New Talent",
 * "Added:"). A "Name:" heading followed by noise ("Reckoning: Now has ...")
 * yields just the name; a possessive followed by noise ends the name
 * ("Holy Shield’s chance to Block"); trailing "Removed" / "in Row 4" are
 * dropped; "A and B" lists are returned as separate names. Results keep order
 * of appearance, are de-duplicated and capped at 6.
 *
 * Only the PARTS are returned (so "Rupture and Garrote" gives both names); the
 * "whole phrase may be a real name" information ("Slice and Dice") is in
 * extractCandidateGroups, which addSubjects uses.
 *
 * Shrinking of long runs that miss on Wowhead happens at lookup time in
 * addSubjects, not here.
 *
 * @param {string} text  plain text of one change
 * @param {{ classSlug?: string|null }} [opts]
 * @returns {string[]} ordered candidate names
 */
export function extractCandidates(text, opts = {}) {
  return extractCandidateGroups(text, opts).flatMap((g) => g.parts);
}

// ---------------------------------------------------------------------------
// LOOKUP (Wowhead search suggestions)
// ---------------------------------------------------------------------------

/** The nine class slugs (docs/SCHEMA.md); used to read a class off a result. */
const CLASS_SLUGS = ['druid', 'hunter', 'mage', 'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior'];

/**
 * The breadcrumb of a suggestion result as an array of strings. The endpoint
 * returns an array (["Talents", "Paladin"]); a bare string is tolerated.
 * @param {object} r  one result
 * @returns {string[]}
 */
function crumbsOf(r) {
  const b = r.pinBreadcrumb;
  if (Array.isArray(b)) return b.filter((c) => typeof c === 'string');
  return typeof b === 'string' && b ? [b] : [];
}

/**
 * The class a result belongs to: the first breadcrumb element naming one of the
 * nine classes, else "Requires <Class>" in `pinDescription`, else null.
 * @param {object} r  one result
 * @returns {string|null} lower-case class slug
 */
function classOfResult(r) {
  for (const c of crumbsOf(r)) {
    const n = normalizeName(c);
    if (CLASS_SLUGS.includes(n)) return n;
  }
  const m = new RegExp(`Requires\\s+(${CLASS_SLUGS.join('|')})\\b`, 'i').exec(String(r.pinDescription ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The subject `kind` of a result (docs/SCHEMA.md v3): items are "item", the
 * "Talents" / "Abilities" breadcrumb roots are "talent" / "ability", any other
 * spell is "spell".
 * @param {object} r  one result
 * @param {'spell'|'item'} type
 * @returns {'talent'|'ability'|'item'|'spell'}
 */
function kindOfResult(r, type) {
  if (type === 'item') return 'item';
  const root = crumbsOf(r)[0];
  if (root === 'Talents') return 'talent';
  if (root === 'Abilities') return 'ability';
  return 'spell';
}

/**
 * Fill in the v3 fields of a stored hit (cache or override). Old cache entries
 * are `{ name, type, icon }`; they become kind "spell" / "item" and class null.
 * @param {{ name: string, type: string, icon: string, kind?: string, class?: string|null }|null} entry
 * @returns {{ name: string, type: 'spell'|'item', kind: string, class: string|null, icon: string }|null}
 */
function normalizeHit(entry) {
  if (!entry) return null;
  return {
    name: entry.name,
    type: entry.type,
    kind: entry.kind ?? (entry.type === 'item' ? 'item' : 'spell'),
    class: entry.class ?? null,
    icon: entry.icon,
  };
}

/**
 * True for a cache entry written before schema v3: a spell hit without `kind`.
 * Such entries keep working (kind "spell", class null) but are re-looked-up
 * when the budget allows, to learn their kind and class. Old ITEM hits need no
 * network call (their kind is always "item").
 * @param {object|null|undefined} entry
 * @returns {boolean}
 */
export function isStaleEntry(entry) {
  return !!entry && !Object.hasOwn(entry, 'kind') && entry.type === 'spell';
}

/**
 * Pick the accepted result from a suggestions response.
 *
 * Acceptance rule: `name` equals the candidate (case-insensitive, curly and
 * straight apostrophes equivalent), `typeName` is "Spell" or "Item" (quests,
 * guides, NPCs are ignored), and an `icon` is present. Among accepted results:
 *   1. results of `preferType` win when there are any, else any type;
 *   2. the pool is ranked (lowest rank wins, ties keep response order):
 *        1  Talents / Abilities of the asking line's class
 *        2  Talents / Abilities of any class
 *        3  other spells of the asking line's class (e.g. Uncategorized/Paladin)
 *        4  every other spell, and items
 *        5  "NPC Abilities" (only when nothing else matched)
 *      Within ranks 1 and 2 a talent beats an ability: when "Holy Shield" is
 *      both, a change about it is usually about the talent.
 *
 * @param {object[]} results  the `results` array from the endpoint
 * @param {string} name       candidate name
 * @param {{ preferType?: 'spell'|'item'|null, classSlug?: string|null }} [opts]
 * @returns {{ name: string, type: 'spell'|'item', kind: string, class: string|null, icon: string } | null}
 */
function pickResult(results, name, { preferType, classSlug } = {}) {
  const want = normalizeName(name);
  const wantClass = classSlug ? String(classSlug).toLowerCase() : null;
  const exact = results
    .filter((r) => r && typeof r === 'object'
      && (r.typeName === 'Spell' || r.typeName === 'Item')
      && typeof r.icon === 'string' && r.icon !== ''
      && typeof r.name === 'string' && normalizeName(r.name) === want)
    .map((raw, index) => {
      const type = raw.typeName === 'Spell' ? 'spell' : 'item';
      return { raw, index, type, kind: kindOfResult(raw, type), class: classOfResult(raw) };
    });
  if (exact.length === 0) return null;

  const preferred = preferType ? exact.filter((e) => e.type === preferType) : [];
  const pool = preferred.length ? preferred : exact;

  /** Rank of one candidate result, see the table above. */
  const rank = (e) => {
    if (e.type === 'item') return 4;
    if (crumbsOf(e.raw)[0] === 'NPC Abilities') return 5;
    const skill = e.kind === 'talent' || e.kind === 'ability';
    if (skill && wantClass && e.class === wantClass) return 1;
    if (skill) return 2;
    if (wantClass && e.class === wantClass) return 3;
    return 4;
  };
  // Talent before ability, but only inside the skill ranks.
  const talentFirst = (e) => (rank(e) <= 2 && e.kind === 'talent' ? 0 : 1);
  const [chosen] = [...pool].sort((x, y) =>
    rank(x) - rank(y) || talentFirst(x) - talentFirst(y) || x.index - y.index);
  return { name: chosen.raw.name, type: chosen.type, kind: chosen.kind, class: chosen.class, icon: chosen.raw.icon };
}

/**
 * Shared per-run network budget and circuit breaker, so that many lookupName
 * calls (one run of addSubjects) honour the same limits.
 *
 * Defaults: 250 lookups, 1.5 s apart. Wowhead answered ~270 lookups at 0.4 s
 * spacing and then returned HTTP 403; 150 at 1.2 s worked twice. 250 at 1.5 s
 * is about 6 minutes per run, which clears the ~650-name backlog (and the
 * stale-entry refreshes) within a few 6-hourly runs while staying slower and
 * smaller than the call pattern that was blocked.
 *
 * @param {{ maxLookups?: number, delayMs?: number, log?: Function }} [opts]
 * @returns {{ maxLookups: number, delayMs: number, log: Function, calls: number,
 *   failures: number, stopped: boolean, warnedCap: boolean }}
 */
export function createLimits({ maxLookups = 250, delayMs = 1500, log = console.error } = {}) {
  return { maxLookups, delayMs, log, calls: 0, failures: 0, stopped: false, warnedCap: false };
}

/** Promise-based sleep; resolves immediately for non-positive durations. */
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Perform one suggestions request. Throws on network error, timeout, non-2xx
 * status, invalid JSON, or a body without a `results` array.
 * @param {string} name
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<object[]>}
 */
async function fetchSuggestions(name, fetchImpl) {
  const res = await fetchImpl(SUGGEST_URL + encodeURIComponent(name), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // 15 s hard timeout
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.results)) throw new Error('unexpected response shape');
  return body.results;
}

/**
 * Resolve one name to `{ name, type, kind, class, icon }` or `null`.
 *
 * Order of consultation: overrides, then the in-memory cache, then the network.
 * Definitive answers (hit or miss) are written to `cache` under the normalised
 * name in the v3 shape. Errors, an exhausted `maxLookups` budget and an open
 * circuit breaker all return `null` WITHOUT touching the cache ("unknown for
 * now"). Never throws because of the network.
 *
 * Old-shape cache hits are returned normalised (kind "spell"/"item", class
 * null). With `force: true` the cache is skipped and the entry is re-fetched
 * (the stale-entry refresh): a failed or exhausted refresh returns the old
 * entry untouched, a definitive miss rewrites the old entry in the new shape
 * instead of losing the icon.
 *
 * The cache is keyed by name only, so the first asking line's class decides
 * between several same-named spells; later lines (of any class) reuse that pick.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  defaults to global fetch
 * @param {Record<string, object|null>} [opts.cache]  mutated in place
 * @param {'spell'|'item'|null} [opts.preferType]
 * @param {string|null} [opts.classSlug]   the asking line's class
 * @param {Record<string, object|null>} [opts.overrides]  hand-edited, win over all
 * @param {boolean} [opts.force]  refresh a stored entry from the network
 * @param {ReturnType<typeof createLimits>} [opts.limits]  shared budget; a fresh
 *   unlimited-delay one is created per call when omitted
 * @returns {Promise<{ name: string, type: 'spell'|'item', kind: string, class: string|null, icon: string } | null>}
 */
export async function lookupName(name, {
  fetchImpl = globalThis.fetch, cache = {}, preferType, classSlug, overrides = {},
  force = false, limits = createLimits({ delayMs: 0 }),
} = {}) {
  const key = normalizeName(name);
  if (Object.hasOwn(overrides, key)) return normalizeHit(overrides[key]);
  const stored = Object.hasOwn(cache, key) ? cache[key] : undefined;
  if (stored !== undefined && !force) return normalizeHit(stored);
  const fallback = normalizeHit(stored); // what to return if the refresh cannot happen

  // Budget / breaker checks: leave the name uncached so a later run retries.
  if (limits.stopped) return fallback;
  if (limits.calls >= limits.maxLookups) {
    if (!limits.warnedCap) {
      limits.log(`icons: lookup budget of ${limits.maxLookups} reached; the rest waits for the next run`);
      limits.warnedCap = true;
    }
    return fallback;
  }

  if (limits.calls > 0) await sleep(limits.delayMs); // be polite between calls
  limits.calls += 1;
  let results;
  try {
    results = await fetchSuggestions(name, fetchImpl);
  } catch (err) {
    limits.failures += 1;
    limits.log(`icons: lookup of "${name}" failed (${err.message}); not cached`);
    if (limits.failures >= MAX_CONSECUTIVE_FAILURES) {
      limits.stopped = true;
      limits.log(`icons: ${MAX_CONSECUTIVE_FAILURES} consecutive failures; no more network calls this run`);
    }
    return fallback;
  }
  limits.failures = 0;

  const hit = pickResult(results, name, { preferType, classSlug });
  // A refresh that finds nothing now keeps the old icon, in the new shape.
  cache[key] = hit ?? (force ? fallback : null);
  return hit ?? fallback;
}

// ---------------------------------------------------------------------------
// ADDING SUBJECTS TO THE DAYS STRUCTURE
// ---------------------------------------------------------------------------

/**
 * Candidate groups of a whole change: the groups of its text first, then those
 * of each note, de-duplicated by name (a name found in the text is not looked
 * up again for the notes) and capped at MAX_SUBJECTS names in total.
 *
 * @param {{ text?: string, notes?: string[] }} change
 * @returns {import('./icons.mjs').CandidateGroup[]}
 */
export function changeCandidateGroups(change) {
  const sources = [change.text ?? '', ...(Array.isArray(change.notes) ? change.notes : [])];
  const seen = new Set();
  const out = [];
  let count = 0;
  for (const src of sources) {
    for (const g of extractCandidateGroups(src)) {
      const fresh = g.parts.filter((n) => !seen.has(normalizeName(n)));
      if (!fresh.length && !g.whole) continue;
      if (g.whole && seen.has(normalizeName(g.whole))) continue;
      const room = MAX_SUBJECTS - count;
      if (room <= 0) return out;
      const parts = fresh.slice(0, room);
      parts.forEach((n) => seen.add(normalizeName(n)));
      if (g.whole) seen.add(normalizeName(g.whole));
      count += parts.length;
      out.push({ whole: parts.length === g.parts.length ? g.whole : null, parts });
    }
  }
  return out;
}

/**
 * Lookup variants for one candidate, in the order they are tried:
 *   1. the full phrase;
 *   2. the pieces left over when the phrase is split at weak connectors
 *      (in / for / to / and), e.g. "Fear Ward and Power Infusion" -> "Fear Ward",
 *      "Power Infusion";
 *   3. the phrase shrunk from the left one word at a time, e.g.
 *      "Greater Lesser Rock Elemental" -> "Lesser Rock Elemental" -> "Rock Elemental".
 * Variants that start with a connector, are a single filler / generic word, or
 * are a single word derived from a longer phrase, are skipped. Misses are cached, so the extra variants cost one call each, once.
 *
 * @param {string} candidate
 * @returns {string[]} distinct variants, full phrase first
 */
function lookupVariants(candidate) {
  const tokens = candidate.split(' ');
  const variants = [candidate];

  // 2. Split at weak lower-case connectors.
  let piece = [];
  const pieces = [];
  for (const t of tokens) {
    if (WEAK_CONNECTORS.has(t)) { pieces.push(piece); piece = []; } else piece.push(t);
  }
  pieces.push(piece);
  if (pieces.length > 1) for (const p of pieces) if (p.length) variants.push(p.join(' '));

  // 3. Shrink from the left.
  for (let i = 1; i < tokens.length; i++) {
    const rest = tokens.slice(i);
    if (CONNECTORS.has(rest[0])) continue; // "of Command" is not a name
    variants.push(rest.join(' '));
  }

  const seen = new Set();
  return variants.filter((v) => {
    const key = normalizeName(v);
    if (seen.has(key)) return false;
    seen.add(key);
    const vt = v.split(' ');
    // A single filler / generic word is never worth a network call.
    if (vt.length === 1 && (FILLER_WORDS.has(key) || isGenericToken(vt[0]))) return false;
    // Review fix: a single word DERIVED from a longer phrase ("Elemental" from
    // "Lesser Rock Elemental", "Dead" from "The Quick and the Dead") is far
    // more likely to hit an unrelated spell or item of that exact name than
    // the thing the line is about, and a wrong icon is worse than the class
    // fallback. Single words are only looked up when they are the candidate
    // itself (e.g. "Redoubt", "Consecration").
    if (vt.length === 1 && v !== candidate) return false;
    return true;
  });
}

/**
 * Read a JSON file holding an object. A missing file yields `{}` silently; a
 * corrupt or non-object file yields `{}` with a log line.
 * @param {string} path
 * @param {Function} log
 * @returns {Promise<Record<string, any>>}
 */
async function readJsonObject(path, log) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log(`icons: cannot read ${path} (${err.message}); starting empty`);
    return {};
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* fall through to the log line */ }
  log(`icons: ${path} is not a JSON object; starting empty`);
  return {};
}

/**
 * Load the hand-edited alias table (`{ "<lower-cased written name>": "Canonical
 * Name" }`). A missing or corrupt file, or a non-object, yields no aliases and
 * one log line; entries whose value is not a non-empty string are ignored.
 * Keys are normalised like cache keys.
 * @param {string} path
 * @param {Function} log
 * @returns {Promise<Record<string, string>>}
 */
async function loadAliases(path, log) {
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    log(`icons: no usable alias file ${path} (${err.code ?? err.message}); no aliases`);
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    log(`icons: ${path} is not a JSON object; no aliases`);
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v.trim()) out[normalizeName(k)] = v.trim();
  }
  return out;
}

/**
 * Preferred subject type for a change: class-scope lines are about spells, item
 * and profession-like categories are about items, anything else has no
 * preference.
 * @param {{ scope?: string, category?: string }} change
 * @returns {'spell'|'item'|null}
 */
function preferTypeFor(change) {
  if (change.scope === 'class') return 'spell';
  if (/^items?$|profession|crafting|recipe/i.test(change.category ?? '')) return 'item';
  return null;
}

/**
 * Fill `subjects` on every change of every day (see docs/SCHEMA.md, v3).
 *
 * Subjects come from the change text first, then from its notes. Source order
 * per name: overrides, game-data index ("client"), Wowhead ("wowhead"). Steps:
 *   1. RESOLVE: walk the changes in priority order (class lines before general
 *      lines, newest day first); names unknown to the client index are looked
 *      up on Wowhead, never-looked-up ones first;
 *   2. VERIFY: with the budget left, cross-check client-resolved names that
 *      have no Wowhead answer yet (max 100 per run) -> subject.verified;
 *   3. REFRESH: then re-look-up stale cache entries (v2-shape spell hits) to
 *      learn their kind and class;
 *   4. ASSEMBLE: build each change's `subjects` from the cache / index alone.
 * Finally the cache is written back (sorted keys, 2-space JSON). Never throws
 * because of the network.
 *
 * @param {{ changes: object[] }[]} days  mutated in place
 * @param {object} [opts]
 * @param {string} [opts.cachePath]
 * @param {string} [opts.overridesPath]
 * @param {string} [opts.aliasesPath]  data/name-aliases.json
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.delayMs]    pause between network calls
 * @param {number} [opts.maxLookups] cap on network calls this run
 * @param {{ lookup: Function }|null} [opts.gameIndex] game-client data index
 *   (scripts/gamedata.mjs): `lookup(name, { classSlug, preferType })` returns
 *   `{ name, type, kind, class, tree, icon }` or null, synchronously and without
 *   network. Primary source; null = Wowhead only.
 * @param {Function} [opts.log]      one-line logger
 * @returns {Promise<object[]>} the same `days`
 */
export async function addSubjects(days, {
  cachePath = 'data/icon-cache.json',
  overridesPath = 'data/icon-overrides.json',
  aliasesPath = 'data/name-aliases.json',
  fetchImpl = globalThis.fetch,
  delayMs = 1500,
  maxLookups = 250,
  gameIndex = null,
  log = console.error,
} = {}) {
  const cache = await readJsonObject(cachePath, log);
  const overrides = await readJsonObject(overridesPath, log);
  const aliases = await loadAliases(aliasesPath, log);
  const limits = createLimits({ maxLookups, delayMs, log });
  // A limits object that never touches the network: assembly reads the cache only.
  const offline = createLimits({ maxLookups: 0, delayMs: 0, log: () => {} });
  offline.stopped = true;
  const mismatches = new Set(); // names already logged as client/Wowhead icon mismatches

  // Priority order: class lines first, then general; `days` is newest-first and
  // Array.sort is stable, so within each group newer days stay first.
  const refs = days.flatMap((day) => (day.changes ?? []).map((change) => ({ day, change })));
  const ordered = [...refs].sort((a, b) =>
    (a.change.scope === 'class' ? 0 : 1) - (b.change.scope === 'class' ? 0 : 1)
    || (a.day.date < b.day.date ? 1 : a.day.date > b.day.date ? -1 : 0));

  /**
   * Resolve ONE name, in the documented source order:
   *   1. overrides file               -> source "override"
   *   2. the game-data index (client) -> source "client"; free, no budget. When
   *      the Wowhead cache already holds an icon for the name, `verified` says
   *      whether the two icons agree (the client icon is kept either way);
   *   3. Wowhead (cache, then network) -> source "wowhead".
   * Returns the subject fields or null ("not found / unknown for now").
   */
  const resolveName = async (name, ctx, lim) => {
    const key = normalizeName(name);
    if (Object.hasOwn(overrides, key)) {
      const o = overrides[key];
      return o ? { ...normalizeHit(o), tree: o.tree ?? null, source: 'override' } : null;
    }
    let client = null;
    if (gameIndex) {
      try { client = gameIndex.lookup(name, { classSlug: ctx.classSlug, preferType: ctx.preferType }); } catch { client = null; }
    }
    if (client) {
      const hit = { name: client.name, type: client.type, kind: client.kind, class: client.class ?? null,
        tree: client.tree ?? null, icon: client.icon, source: 'client' };
      const wh = cache[key]; // the Wowhead answer, if any (never fetched here)
      if (wh && wh.icon) {
        hit.verified = String(wh.icon).toLowerCase() === String(client.icon).toLowerCase();
        if (!hit.verified && !mismatches.has(key)) {
          mismatches.add(key);
          log(`icons: icon mismatch for "${client.name}": client ${client.icon} vs wowhead ${wh.icon} (keeping client)`);
        }
      }
      return hit;
    }
    const wh = await lookupName(name, { fetchImpl, cache, preferType: ctx.preferType, classSlug: ctx.classSlug, overrides, limits: lim });
    return wh ? { ...wh, tree: null, source: 'wowhead' } : null;
  };

  /**
   * Resolve a name through the alias table first: a name as written in the
   * notes ("Unsealed Fury") may be called something else in the game data
   * ("Unsealed Wrath"). The canonical name goes through resolveName; the subject
   * keeps the written name and gets `alias: <canonical name>`. An alias whose
   * target is unknown falls through to a normal resolution of the written name.
   */
  const resolveAliased = async (name, ctx, lim) => {
    const target = aliases[normalizeName(name)];
    if (target) {
      const hit = await resolveName(target, ctx, lim);
      if (hit) return { ...hit, name, alias: target };
    }
    return resolveName(name, ctx, lim);
  };

  /**
   * Resolve one change's groups into subjects using `lim` (real or offline
   * limits). `collect` (optional `{ stale, verify }` Maps) gathers the
   * follow-up work: v2-shape Wowhead spell entries to refresh, and
   * client-resolved names without a Wowhead answer yet to cross-check.
   */
  const resolveChange = async (change, lim, collect) => {
    const ctx = { classSlug: change.class ?? null, preferType: preferTypeFor(change) };
    const subjects = [];
    const taken = new Set();
    const take = (hit, queried) => {
      const id = `${hit.type}:${normalizeName(hit.name)}`;
      if (taken.has(id) || subjects.length >= MAX_SUBJECTS) return;
      taken.add(id);
      const subject = { name: hit.name, type: hit.type, kind: hit.kind, class: hit.class, tree: hit.tree, icon: hit.icon, source: hit.source };
      if (hit.verified !== undefined) subject.verified = hit.verified;
      if (hit.alias) subject.alias = hit.alias;
      subjects.push(subject);
      if (!collect) return;
      const canonical = hit.alias ?? queried; // follow-up lookups use the game-data name
      const key = normalizeName(canonical);
      const job = { name: canonical, ...ctx };
      if (hit.source === 'wowhead' && isStaleEntry(cache[key]) && !collect.stale.has(key)) collect.stale.set(key, job);
      if (hit.source === 'client' && !Object.hasOwn(cache, key) && !collect.verify.has(key)) collect.verify.set(key, job);
    };
    for (const group of changeCandidateGroups(change)) {
      if (group.whole) {
        const whole = await resolveAliased(group.whole, ctx, lim);
        if (whole) { take(whole, group.whole); continue; } // a real "A and B" name: parts are not needed
      }
      for (const part of group.parts) {
        for (const variant of lookupVariants(part)) {
          const hit = await resolveAliased(variant, ctx, lim);
          if (hit) { take(hit, variant); break; } // first variant that resolves wins for this candidate
          const key = normalizeName(variant);
          const answered = Object.hasOwn(cache, key) || Object.hasOwn(overrides, key);
          if (!answered) break; // inconclusive (error / budget): do not burn more calls on this candidate
        }
      }
    }
    return subjects;
  };

  // 1. Resolve names the client index does not know (it answers the rest for
  //    free), most valuable lines first. Never-looked-up names come first.
  for (const { change } of ordered) await resolveChange(change, limits);
  const lookedUp = limits.calls;

  // 2. Cross-check client-resolved names with no Wowhead answer yet (at most
  //    MAX_VERIFY_LOOKUPS per run), then 3. refresh stale entries. Both with
  //    whatever budget is left.
  const collect = { stale: new Map(), verify: new Map() };
  for (const { change } of ordered) await resolveChange(change, offline, collect);
  let verifies = 0;
  for (const [, job] of collect.verify) {
    if (verifies >= MAX_VERIFY_LOOKUPS || limits.stopped || limits.calls >= limits.maxLookups) break;
    verifies += 1;
    await lookupName(job.name, { fetchImpl, cache, preferType: job.preferType, classSlug: job.classSlug, overrides, limits });
  }
  const afterVerify = limits.calls;
  for (const [, job] of collect.stale) {
    if (limits.stopped || limits.calls >= limits.maxLookups) break;
    await lookupName(job.name, { fetchImpl, cache, preferType: job.preferType, classSlug: job.classSlug, overrides, force: true, limits });
  }
  log(`icons: ${lookedUp} new lookups, ${afterVerify - lookedUp} verification lookups, ${limits.calls - afterVerify} stale refreshes`
    + ` (${collect.verify.size} unverified, ${collect.stale.size} stale in use)`);

  // 4. Assemble from the cache (and the client index).
  for (const { change } of refs) change.subjects = await resolveChange(change, offline);

  // Write the cache back with sorted keys so diffs stay minimal and stable.
  const sorted = Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]]));
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(sorted, null, 2) + '\n');
  } catch (err) {
    log(`icons: could not write ${cachePath} (${err.message})`);
  }
  return days;
}
