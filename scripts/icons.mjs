// scripts/icons.mjs
//
// PURPOSE
//   Icon / subject resolver for the "WoW: Forever changes" pipeline (step 3 in
//   docs/PLAN.md). For every change line in the days structure described in
//   docs/SCHEMA.md it finds the skills and items named in `text` and fills
//   `change.subjects` with `{ name, type: 'spell' | 'item', icon }` entries.
//   The first subject supplies the line's icon in the web app; with no subjects
//   the app falls back to a class / category icon.
//
// DESIGN
//   1. extractCandidates(text)  - purely textual heuristic. Finds runs of
//      Capitalised Words that look like proper names, minus quotes, parentheses,
//      rank suffixes, zone prefixes and a stoplist of filler / generic terms.
//   2. lookupName(name, ...)    - asks Wowhead's search-suggestions endpoint and
//      accepts only an exact (case-insensitive) Spell or Item match with an icon.
//   3. addSubjects(days, ...)   - glues 1 and 2 together, with an on-disk cache.
//
//   Everything that touches the network goes through an injectable `fetchImpl`,
//   so the unit tests use stubs and never need the internet.
//
// CACHE  (data/icon-cache.json)
//   Keyed by the lower-cased name (curly apostrophes normalised to straight).
//   A hit is stored as `{ name, type, icon }`, a definitive miss as `null`, so
//   nothing is ever looked up twice. Network / HTTP / JSON errors are NOT cached
//   (the answer is "unknown for now"; the next run tries again).
//
// OVERRIDES  (data/icon-overrides.json)  -- hand-edited
//   Same shape as the cache: `{ "<lower-cased name>": { name, type, icon } | null }`.
//   An override WINS over both the cache and the network. Use an entry to fix a
//   wrong icon, to supply an icon for something Wowhead does not list, or set the
//   value to `null` to stop a name from ever being resolved (a false positive).
//   The file is never written by this script. Plain JSON has no comments, so
//   this header is the documentation.
//
// POLITENESS
//   Requests are strictly sequential, separated by `delayMs`, carry an honest
//   User-Agent, time out after 15 s, and are capped at `maxLookups` new network
//   calls per run. After 5 consecutive failures the run stops calling the network.
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

/** Maximum number of candidates kept per change line. */
const MAX_CANDIDATES = 4;

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
 * True when the whole phrase is not a candidate: it is itself a generic term
 * ("Cooldown Manager", "Spell Power") or every word is generic ("Holy Mace").
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isGenericPhrase(tokens) {
  const phrase = normalizeName(tokens.join(' ')).replace(/:/g, '');
  if (GENERIC_SET.has(phrase) || CLASS_AND_SPEC_SET.has(phrase)) return true;
  // Lower-case connectors are ignored so "Mace and Sword" counts as all-generic.
  return tokens.every((t) => CONNECTORS.has(t) || isGenericToken(t));
}

/**
 * Split one regex run into name segments and clean each of them:
 *   - a possessive followed by a generic word ends the segment
 *     ("Eye’s Spirit" -> "Eye", then "Spirit" which is dropped as generic);
 *   - a trailing possessive is stripped ("Eye’s" -> "Eye");
 *   - leading filler words are stripped ("Fixed Consecration" -> "Consecration");
 *   - segments that are entirely generic vocabulary are discarded.
 * @param {string} run
 * @returns {string[]} cleaned names (possibly empty)
 */
function segmentsFromRun(run) {
  const tokens = run.split(/\s+/);
  const groups = [];
  let current = [];
  tokens.forEach((tok, i) => {
    current.push(tok);
    const possessive = /['’]s:?$/i.test(tok);
    const next = tokens.slice(i + 1).find((t) => !CONNECTORS.has(t));
    // Possessive in the middle of a run only splits when what follows is generic.
    if (possessive && next !== undefined && isGenericToken(next)) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length) groups.push(current);

  const names = [];
  for (let g of groups) {
    // Drop leading filler ("Fixed", "The", "Players", ...). Compare without colon.
    while (g.length && FILLER_WORDS.has(normalizeName(g[0]).replace(/:$/, ''))) g = g.slice(1);
    // A run cannot end on a connector, but a stripped colon may remain.
    if (!g.length) continue;
    g = [...g];
    // Strip a trailing possessive / colon from the last word only.
    g[g.length - 1] = g[g.length - 1].replace(/['’]s$/i, '').replace(/:$/, '');
    if (!g[g.length - 1]) continue;
    if (isGenericPhrase(g)) continue;
    names.push(g.join(' '));
  }
  return names;
}

/**
 * Find the skill / item names mentioned in one change line.
 *
 * Heuristic: runs of Capitalised Words (with lower-case connectors such as
 * "of"/"the") that survive the stoplists, after removing quotes, parentheses,
 * rank suffixes and zone prefixes. Single capitalised words count too unless
 * they are filler or generic. Results keep order of appearance, are
 * de-duplicated case-insensitively and capped at 4.
 *
 * Shrinking of long runs that miss on Wowhead (e.g. "Lesser Rock Elemental" ->
 * "Rock Elemental") happens at lookup time in addSubjects, not here, so that
 * this function stays a stable, easily tested "what looks like a name" step.
 *
 * @param {string} text  plain text of one change
 * @param {{ classSlug?: string|null }} [opts]  classSlug is accepted for API
 *   symmetry with lookupName; class names are already stoplisted globally.
 * @returns {string[]} ordered candidate names
 */
export function extractCandidates(text, { classSlug } = {}) {
  void classSlug; // reserved: every class name is already in the stoplist
  const cleaned = cleanText(text);
  const seen = new Set();
  const out = [];
  for (const m of cleaned.matchAll(RUN_RE)) {
    for (const name of segmentsFromRun(m[0])) {
      const key = normalizeName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}
