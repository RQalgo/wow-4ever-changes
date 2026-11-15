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
  // Patch-note verbs / adverbs that start a sentence or follow a "Name:" prefix
  // ("Reckoning: Replaced ...", "Additionally, ..."). Added with the v3 rules.
  'replaced', 'replaces', 'gives', 'reduces', 'additionally', 'addressed', 'completing',
  'deployed', 'does', 'beyond', 'renamed', 'moved', 'new',
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

// ---------------------------------------------------------------------------
// LOOKUP (Wowhead search suggestions)
// ---------------------------------------------------------------------------

/**
 * Pick the accepted result from a suggestions response.
 *
 * Acceptance rule: `name` equals the candidate (case-insensitive, curly and
 * straight apostrophes equivalent), `typeName` is "Spell" or "Item", and an
 * `icon` is present. Among accepted results:
 *   1. results of `preferType` win when there are any, else any type;
 *   2. when several Spell results remain and `classSlug` is known, the first one
 *      whose `pinDescription` / `pinBreadcrumb` mentions that class wins;
 *   3. otherwise the first.
 *
 * @param {object[]} results  the `results` array from the endpoint
 * @param {string} name       candidate name
 * @param {{ preferType?: 'spell'|'item'|null, classSlug?: string|null }} [opts]
 * @returns {{ name: string, type: 'spell'|'item', icon: string } | null}
 */
function pickResult(results, name, { preferType, classSlug } = {}) {
  const want = normalizeName(name);
  const exact = results
    .filter((r) => r && typeof r === 'object'
      && (r.typeName === 'Spell' || r.typeName === 'Item')
      && typeof r.icon === 'string' && r.icon !== ''
      && typeof r.name === 'string' && normalizeName(r.name) === want)
    .map((r) => ({ raw: r, type: r.typeName === 'Spell' ? 'spell' : 'item' }));
  if (exact.length === 0) return null;

  const preferred = preferType ? exact.filter((e) => e.type === preferType) : [];
  const pool = preferred.length ? preferred : exact;

  let chosen = pool[0];
  const spells = pool.filter((e) => e.type === 'spell');
  if (classSlug && spells.length > 1) {
    // pinDescription / pinBreadcrumb may be strings or structures; stringify both.
    const wantClass = String(classSlug).toLowerCase();
    const byClass = spells.find((e) =>
      JSON.stringify([e.raw.pinDescription, e.raw.pinBreadcrumb]).toLowerCase().includes(wantClass));
    if (byClass) chosen = byClass; // otherwise keep the first exact match
  }
  return { name: chosen.raw.name, type: chosen.type, icon: chosen.raw.icon };
}

/**
 * Shared per-run network budget and circuit breaker, so that many lookupName
 * calls (one run of addSubjects) honour the same limits.
 *
 * @param {{ maxLookups?: number, delayMs?: number, log?: Function }} [opts]
 * @returns {{ maxLookups: number, delayMs: number, log: Function, calls: number,
 *   failures: number, stopped: boolean, warnedCap: boolean }}
 */
export function createLimits({ maxLookups = 150, delayMs = 1200, log = console.error } = {}) {
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
 * Resolve one name to `{ name, type, icon }` or `null`.
 *
 * Order of consultation: overrides, then the in-memory cache, then the network.
 * Definitive answers (hit or miss) are written to `cache` under the normalised
 * name. Errors, an exhausted `maxLookups` budget and an open circuit breaker all
 * return `null` WITHOUT touching the cache ("unknown for now").
 * Never throws because of the network.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  defaults to global fetch
 * @param {Record<string, object|null>} [opts.cache]  mutated in place
 * @param {'spell'|'item'|null} [opts.preferType]
 * @param {string|null} [opts.classSlug]   used to disambiguate several spells
 * @param {Record<string, object|null>} [opts.overrides]  hand-edited, win over all
 * @param {ReturnType<typeof createLimits>} [opts.limits]  shared budget; a fresh
 *   unlimited-delay one is created per call when omitted
 * @returns {Promise<{ name: string, type: 'spell'|'item', icon: string } | null>}
 */
export async function lookupName(name, {
  fetchImpl = globalThis.fetch, cache = {}, preferType, classSlug, overrides = {},
  limits = createLimits({ delayMs: 0 }),
} = {}) {
  const key = normalizeName(name);
  if (Object.hasOwn(overrides, key)) return overrides[key];
  if (Object.hasOwn(cache, key)) return cache[key];

  // Budget / breaker checks: leave the name uncached so a later run retries.
  if (limits.stopped) return null;
  if (limits.calls >= limits.maxLookups) {
    if (!limits.warnedCap) {
      limits.log(`icons: lookup budget of ${limits.maxLookups} reached; the rest waits for the next run`);
      limits.warnedCap = true;
    }
    return null;
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
    return null;
  }
  limits.failures = 0;

  const hit = pickResult(results, name, { preferType, classSlug });
  cache[key] = hit; // hit, or null for a definitive miss
  return hit;
}

// ---------------------------------------------------------------------------
// ADDING SUBJECTS TO THE DAYS STRUCTURE
// ---------------------------------------------------------------------------

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
 * Fill `subjects` on every change of every day (see docs/SCHEMA.md).
 *
 * Loads the cache and the hand-edited overrides, resolves each change's
 * candidates sequentially (with fallback variants, see lookupVariants), and
 * writes the cache back (sorted keys, 2-space JSON) at the end. Changes that
 * already have subjects are simply recomputed; the cache makes that free.
 * Never throws because of the network.
 *
 * @param {{ changes: object[] }[]} days  mutated in place
 * @param {object} [opts]
 * @param {string} [opts.cachePath]
 * @param {string} [opts.overridesPath]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.delayMs]    pause between network calls
 * @param {number} [opts.maxLookups] cap on new network calls this run
 * @param {Function} [opts.log]      one-line logger
 * @returns {Promise<object[]>} the same `days`
 */
// Defaults are deliberately gentle: in the first real run Wowhead answered
// ~270 lookups at 400 ms spacing and then started returning HTTP 403 (rate
// limiting). 150 lookups per run at 1.2 s spacing stays well below that; the
// cache means later runs only look up names that are new or still unknown.
export async function addSubjects(days, {
  cachePath = 'data/icon-cache.json',
  overridesPath = 'data/icon-overrides.json',
  fetchImpl = globalThis.fetch,
  delayMs = 1200,
  maxLookups = 150,
  log = console.error,
} = {}) {
  const cache = await readJsonObject(cachePath, log);
  const overrides = await readJsonObject(overridesPath, log);
  const limits = createLimits({ maxLookups, delayMs, log });

  for (const day of days) {
    for (const change of day.changes ?? []) {
      const classSlug = change.class ?? null;
      const preferType = preferTypeFor(change);
      const subjects = [];
      const taken = new Set();
      for (const candidate of extractCandidates(change.text, { classSlug })) {
        for (const variant of lookupVariants(candidate)) {
          const hit = await lookupName(variant, { fetchImpl, cache, preferType, classSlug, overrides, limits });
          if (hit) {
            const id = `${hit.type}:${normalizeName(hit.name)}`;
            if (!taken.has(id)) { taken.add(id); subjects.push({ name: hit.name, type: hit.type, icon: hit.icon }); }
            break; // first variant that resolves wins for this candidate
          }
          const key = normalizeName(variant);
          const answered = Object.hasOwn(cache, key) || Object.hasOwn(overrides, key);
          if (!answered) break; // inconclusive (error / budget): do not burn more calls on this candidate
        }
      }
      change.subjects = subjects;
    }
  }

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
