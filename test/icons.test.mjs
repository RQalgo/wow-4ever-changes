// test/icons.test.mjs
//
// Unit tests for scripts/icons.mjs. Run with `node --test`.
// Nothing here touches the network: every lookup uses a stubbed `fetchImpl`.
//
// Sections: (1) candidate extraction, (2) lookupName, (3) addSubjects.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCandidates, extractCandidateGroups, lookupName, addSubjects, createLimits } from '../scripts/icons.mjs';

// ---------------------------------------------------------------------------
// 1. Candidate extraction
// ---------------------------------------------------------------------------

describe('extractCandidates', () => {
  /** [input line, expected candidates] pairs, mostly realistic hotfix lines. */
  const cases = [
    ['Judgement of Command now activates on-hit effects and counts as a melee attack.', ['Judgement of Command']],
    ['Fixed an issue where Consecration could stop dealing increased damage to enemies.', ['Consecration']],
    ['Redoubt can now be tracked in the Cooldown Manager.', ['Redoubt']],
    ['Siphon Life Rank 1 can no longer be cast while silenced.', ['Siphon Life']],
    ['Fixed an issue where Berserker Rage was not removing Sap.', ['Berserker Rage', 'Sap']],
    ['Everstaring Abomination Eye’s Spirit stats corrected.', ['Everstaring Abomination Eye']],
    ["Everstaring Abomination Eye's Spirit stats corrected.", ['Everstaring Abomination Eye']],
    ['Taran Icebreaker now correctly behaves as a 2-handed Mace (was incorrectly behaving as a 1-handed Mace).', ['Taran Icebreaker']],
    ['Unsealed Fury no longer generates echoes from Windfury Totem attacks.', ['Unsealed Fury', 'Windfury Totem']],
    ['Wild Growth healing coefficient increased to 6.6% (was 3.3%).', ['Wild Growth']],
    ['Judgement is now considered a Ranged Attack.', ['Judgement']],
    ['Updated Gloves of Holy Might to grant Spell Power.', ['Gloves of Holy Might']],
    ['Players can now use Sap on Horde targets in Alterac Valley.', ['Sap', 'Alterac Valley']],
    ['Shadow Word: Pain no longer refreshes on Mana drain.', ['Shadow Word: Pain']],
    ['Adjusted the Bind-on-Pickup requirement of Thunderfury.', ['Thunderfury']],
    ['Fixed a bug with diminishing returns on creature stuns.', []],
    ['All Mace and Sword users take less damage.', []],
    ['Resolved an issue with Developers notes and the UI.', []],
    // v3: "A and B" lists are split into parts (the whole is kept separately in
    // extractCandidateGroups, see the groups tests below); before v3 this
    // returned the single candidate 'Sap and Gouge'.
    ['Sap and Gouge now share diminishing returns.', ['Sap', 'Gouge']],

    // --- v3 rules: patch-note style lines (each example from the owner's brief) ---
    ['Reckoning: Now has a 1.5 second cooldown on how often it can be triggered.', ['Reckoning']],
    ['Righteous Fury: Holy threat increase increased to 60% (was 90%).', ['Righteous Fury']],
    ['Lightning Bolt: Base damage increased to 40.', ['Lightning Bolt']],
    ['Aspect of the Hawk: Ranged Attack Power bonus has been reduced.', ['Aspect of the Hawk']],
    ['Bear Form and Dire Bear Form: Threat generation has been reduced.', ['Bear Form', 'Dire Bear Form']],
    ['New Talent Oath of Light in Row 4. 40-yard range, 8% of Base Mana cost. No cooldown. Swear an Oath to protect an ally.', ['Oath of Light']],
    ['New Talent: Quick Getaway grants movement speed after vanishing.', ['Quick Getaway']],
    ['New Talent Stoicism added to Row 5. Reduces the duration of Stun and Charm effects on you.', ['Stoicism']],
    ['Added: Shank deals damage to the target.', ['Shank']],
    ['Instrument of Law Removed.', ['Instrument of Law']],
    ['Lava Burst: Removed.', ['Lava Burst']],
    ['Holy Shield moved to Row 5 (Was Row 7).', ['Holy Shield']],
    ['Holy Shield’s chance to Block changed to 30% (was 20%).', ['Holy Shield']],
    ['Consecration’s Spell Power Coefficient per tick has been changed.', ['Consecration']],
    ['Blessing of Salvation and Greater Blessing of Salvation have been replaced with Salvation and Mass Salvation.',
      ['Blessing of Salvation', 'Greater Blessing of Salvation', 'Salvation', 'Mass Salvation']],
    ['Judgement of Righteousness and Judgement of Fury now have the correct spell power coefficients.',
      ['Judgement of Righteousness', 'Judgement of Fury']],
    ['Improved Seal of Fury and Shield Specialization no longer generate threat.', ['Improved Seal of Fury', 'Shield Specialization']],
    ['Shield Specialization Mana restored to the Paladin lowered to 4%.', ['Shield Specialization']],
    ['Twist of Light now additionally reduces the Mana cost of your Seal spells by 20%.', ['Twist of Light']],
    ['Fireball: Renamed Accelerant.', ['Fireball', 'Accelerant']],
    ['Hemorrhage and Ghostly Strike now deal more damage.', ['Hemorrhage', 'Ghostly Strike']],
    ['Rupture and Garrote now refresh correctly.', ['Rupture', 'Garrote']],
    ['Cure Disease and Abolish Disease no longer conflict.', ['Cure Disease', 'Abolish Disease']],
    ['Heart of the Wild and Gift of the Earthmother now stack.', ['Heart of the Wild', 'Gift of the Earthmother']],
    // A real "Word:" name keeps its colon part; stoplisted nouns are never names.
    ['Power Word: Shield and Shadow Word: Pain were adjusted.', ['Power Word: Shield', 'Shadow Word: Pain']],
    ['Row 5 Base Mana Attack Power Combo Points and Diminishing Returns.', []],
  ];
  for (const [line, expected] of cases) {
    test(line.slice(0, 60), () => assert.deepEqual(extractCandidates(line), expected));
  }

  test('zone prefix "Zone - rest" never yields the zone', () => {
    const got = extractCandidates('Badlands - Lesser Rock Elemental spawns should now appear more frequently.');
    assert.ok(!got.includes('Badlands'));
    assert.deepEqual(got, ['Lesser Rock Elemental']);
  });

  test('quoted quest names are not candidates (curly and straight)', () => {
    const straight = extractCandidates('Fixed an issue during the quest "The Talisman of Kazdor" where rogues would enter the wrong version of Zul\'Farrak.');
    assert.ok(!straight.some((c) => /Talisman|Kazdor/.test(c)));
    assert.deepEqual(straight, ["Zul'Farrak"]);
    const curly = extractCandidates('Fixed the quest “Helping Hands” and Windfury Totem.');
    assert.deepEqual(curly, ['Windfury Totem']);
  });

  test('is capped at 6 candidates and de-duplicated in order', () => {
    const got = extractCandidates('Sap, Gouge, Kick, Evasion, Vanish and Sap again, plus Garrote and Ambush.');
    assert.equal(got.length, 6);
    assert.deepEqual(got, ['Sap', 'Gouge', 'Kick', 'Evasion', 'Vanish', 'Garrote']);
    assert.deepEqual(extractCandidates('Sap now works. Sap is great.'), ['Sap']);
  });

  test('class and spec names alone are not candidates', () => {
    assert.deepEqual(extractCandidates('Retribution Paladin changes.'), []);
    assert.deepEqual(extractCandidates('Rogues and Warriors are happier.'), []);
  });

  test('groups: "A and B" with one word per side keeps the whole as a first try', () => {
    assert.deepEqual(extractCandidateGroups('Slice and Dice now lasts longer.'),
      [{ whole: 'Slice and Dice', parts: ['Slice', 'Dice'] }]);
    assert.equal(extractCandidateGroups('Shadow and Flame is a talent.')[0].whole, 'Shadow and Flame');
    // multi-word sides are lists, not names: no whole
    assert.deepEqual(extractCandidateGroups('Cure Disease and Abolish Disease are fine.'),
      [{ whole: null, parts: ['Cure Disease', 'Abolish Disease'] }]);
    // "of the" never splits
    assert.deepEqual(extractCandidateGroups('Heart of the Wild is fine.'), [{ whole: null, parts: ['Heart of the Wild'] }]);
  });

  test('a plural category noun after one capital word is not a name; a longer run is kept', () => {
    assert.deepEqual(extractCandidates('Reduces the cost of your Seal spells.'), []);
    assert.deepEqual(extractCandidates('Windfury Totem attacks now proc.'), ['Windfury Totem']);
  });

  test('classSlug option is accepted', () => {
    assert.deepEqual(extractCandidates('Sap is fixed.', { classSlug: 'rogue' }), ['Sap']);
  });
});

// ---------------------------------------------------------------------------
// Test helpers: stubbed fetch
// ---------------------------------------------------------------------------

/**
 * Build a stub fetch. `responder(query)` returns the `results` array (or throws,
 * or returns a full Response-like object via `{ raw }`). Records every call.
 * @param {(q: string) => any} responder
 */
function stubFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    calls.push({ url, q, init });
    const out = responder(q);
    if (out && out.raw) return out.raw;
    return { ok: true, status: 200, json: async () => ({ search: q, results: out }) };
  };
  fn.calls = calls;
  return fn;
}

const spell = (name, icon, extra = {}) => ({ type: 6, id: 1, name, typeName: 'Spell', icon, ...extra });
const item = (name, icon, extra = {}) => ({ type: 3, id: 2, name, typeName: 'Item', icon, ...extra });
const quiet = () => {};

// ---------------------------------------------------------------------------
// 2. lookupName
// ---------------------------------------------------------------------------

describe('lookupName', () => {
  test('accepts an exact name match, case-insensitively and with curly apostrophes', async () => {
    const f = stubFetch(() => [spell("Hunter's Mark", 'ability_hunter_snipershot')]);
    const r = await lookupName('hunter’s mark', { fetchImpl: f, cache: {} });
    assert.deepEqual(r, { name: "Hunter's Mark", type: 'spell', kind: 'spell', class: null, icon: 'ability_hunter_snipershot' });
  });

  test('rejects partial matches, other types and results without icon', async () => {
    const f = stubFetch(() => [
      spell('Judgement of Command Rank 2', 'a'),
      { type: 1, id: 3, name: 'Judgement of Command', typeName: 'NPC', icon: 'b' },
      spell('Judgement of Command', ''),
      { type: 6, id: 4, name: 'Judgement of Command', typeName: 'Spell' },
    ]);
    const cache = {};
    assert.equal(await lookupName('Judgement of Command', { fetchImpl: f, cache }), null);
    assert.ok(Object.hasOwn(cache, 'judgement of command'));
  });

  test('sends the endpoint URL, query, honest User-Agent and a timeout signal', async () => {
    const f = stubFetch(() => []);
    await lookupName('Judgement of Command', { fetchImpl: f, cache: {} });
    const [call] = f.calls;
    assert.ok(call.url.startsWith('https://www.wowhead.com/forever/search/suggestions-template?q=Judgement%20of%20Command'));
    assert.equal(call.init.headers['User-Agent'], 'wow-4ever-changes/0.1 (+https://github.com/RQalgo/wow-4ever-changes)');
    assert.ok(call.init.signal instanceof AbortSignal);
  });

  test('preferType spell picks the spell, preferType item picks the item', async () => {
    const results = [item('Sap', 'inv_misc_bag'), spell('Sap', 'ability_sap')];
    const asSpell = await lookupName('Sap', { fetchImpl: stubFetch(() => results), cache: {}, preferType: 'spell' });
    assert.equal(asSpell.type, 'spell');
    const asItem = await lookupName('Sap', { fetchImpl: stubFetch(() => results), cache: {}, preferType: 'item' });
    assert.equal(asItem.type, 'item');
    const none = await lookupName('Sap', { fetchImpl: stubFetch(() => results), cache: {} });
    assert.equal(none.type, 'item'); // no preference: first exact match
  });

  test('falls back to the other type when the preferred type has no exact match', async () => {
    const f = stubFetch(() => [item('Taran Icebreaker', 'inv_mace_13')]);
    const r = await lookupName('Taran Icebreaker', { fetchImpl: f, cache: {}, preferType: 'spell' });
    assert.equal(r.type, 'item');
  });

  test('classSlug prefers the spell whose pin text mentions the class, else the first', async () => {
    const results = [
      spell('Judgement', 'icon_warrior', { pinBreadcrumb: 'Warrior' }),
      // v3: the class is read from "Requires <Class>" (or a breadcrumb element).
      spell('Judgement', 'icon_paladin', { pinDescription: 'Requires Paladin' }),
    ];
    const pal = await lookupName('Judgement', { fetchImpl: stubFetch(() => results), cache: {}, preferType: 'spell', classSlug: 'paladin' });
    assert.equal(pal.icon, 'icon_paladin');
    const mage = await lookupName('Judgement', { fetchImpl: stubFetch(() => results), cache: {}, preferType: 'spell', classSlug: 'mage' });
    assert.equal(mage.icon, 'icon_warrior');
  });

  test('cache hit avoids fetching; hit and miss are both cached', async () => {
    const f = stubFetch((q) => (q === 'Sap' ? [spell('Sap', 'ability_sap')] : []));
    const cache = {};
    const a = await lookupName('Sap', { fetchImpl: f, cache });
    const b = await lookupName('SAP', { fetchImpl: f, cache });
    assert.deepEqual(a, b);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(cache.sap, { name: 'Sap', type: 'spell', kind: 'spell', class: null, icon: 'ability_sap' });
    assert.equal(await lookupName('Nothing Here', { fetchImpl: f, cache }), null);
    assert.equal(await lookupName('nothing here', { fetchImpl: f, cache }), null);
    assert.equal(f.calls.length, 2);
    assert.equal(cache['nothing here'], null);
  });

  test('network error, HTTP error and bad JSON return null and are NOT cached', async () => {
    const cache = {};
    const log = [];
    const limits = createLimits({ delayMs: 0, log: (m) => log.push(m) });
    const boom = async () => { throw new Error('ECONNRESET'); };
    const http = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    const badShape = async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) });
    for (const fetchImpl of [boom, http, badJson, badShape]) {
      assert.equal(await lookupName('Sap', { fetchImpl, cache, limits }), null);
    }
    assert.deepEqual(cache, {});
    assert.equal(log.length, 4); // one line per failure (limit of 5 not yet reached)
  });

  test('a success resets the consecutive-failure counter', async () => {
    const limits = createLimits({ delayMs: 0, log: quiet });
    const boom = async () => { throw new Error('x'); };
    for (let i = 0; i < 4; i++) await lookupName(`N${i}`, { fetchImpl: boom, cache: {}, limits });
    assert.equal(limits.failures, 4);
    await lookupName('Fine', { fetchImpl: stubFetch(() => []), cache: {}, limits });
    assert.equal(limits.failures, 0);
    assert.equal(limits.stopped, false);
  });

  test('circuit breaker: after 5 consecutive failures no more network calls', async () => {
    let n = 0;
    const boom = async () => { n++; throw new Error('down'); };
    const limits = createLimits({ delayMs: 0, log: quiet });
    for (let i = 0; i < 10; i++) await lookupName(`Name${i}`, { fetchImpl: boom, cache: {}, limits });
    assert.equal(n, 5);
    assert.equal(limits.stopped, true);
  });

  test('maxLookups caps new network calls and leaves the rest uncached', async () => {
    const f = stubFetch(() => []);
    const cache = {};
    const logs = [];
    const limits = createLimits({ maxLookups: 2, delayMs: 0, log: (m) => logs.push(m) });
    for (const n of ['A', 'B', 'C', 'D']) await lookupName(n, { fetchImpl: f, cache, limits });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(Object.keys(cache).sort(), ['a', 'b']);
    assert.equal(logs.length, 1); // budget message logged once
  });

  test('overrides win over cache and network, including null overrides', async () => {
    const f = stubFetch(() => [spell('Sap', 'network_icon')]);
    const cache = { sap: { name: 'Sap', type: 'spell', icon: 'cache_icon' } };
    const overrides = {
      sap: { name: 'Sap', type: 'spell', icon: 'override_icon' },
      'bad guess': null,
    };
    assert.equal((await lookupName('Sap', { fetchImpl: f, cache, overrides })).icon, 'override_icon');
    assert.equal(await lookupName('Bad Guess', { fetchImpl: f, cache, overrides }), null);
    assert.equal(f.calls.length, 0);
  });

  test('delayMs is honoured between network calls but not before the first', async () => {
    const f = stubFetch(() => []);
    const limits = createLimits({ delayMs: 60, log: quiet });
    const t0 = Date.now();
    await lookupName('A', { fetchImpl: f, cache: {}, limits });
    const afterFirst = Date.now() - t0;
    await lookupName('B', { fetchImpl: f, cache: {}, limits });
    assert.ok(afterFirst < 50);
    assert.ok(Date.now() - t0 >= 55);
  });
});

// ---------------------------------------------------------------------------
// 3. addSubjects
// ---------------------------------------------------------------------------

describe('addSubjects', () => {
  /** Fresh sample days structure. */
  const makeDays = () => [{
    date: '2026-11-13', label: 'November 13, 2026',
    changes: [
      { id: 'a', scope: 'class', category: 'Classes', class: 'paladin', spec: null, group: null,
        text: 'Judgement of Command now counts as a melee attack.', notes: [], subjects: [] },
      { id: 'b', scope: 'general', category: 'Items', class: null, spec: null, group: null,
        text: 'Taran Icebreaker now behaves as a 2-handed Mace (was 1-handed).', notes: [], subjects: [] },
      { id: 'c', scope: 'general', category: 'Dungeons', class: null, spec: null, group: 'The Deadmines',
        text: 'Badlands - Lesser Rock Elemental spawns more often.', notes: [], subjects: [] },
    ],
  }];

  const responder = (q) => ({
    'Judgement of Command': [spell('Judgement of Command', 'ability_warrior_innerrage')],
    'Taran Icebreaker': [item('Taran Icebreaker', 'inv_mace_13')],
  }[q] ?? []);

  test('fills subjects, uses fallback variants, persists a sorted cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'icons-test-'));
    try {
      const cachePath = join(dir, 'nested', 'cache.json');
      const overridesPath = join(dir, 'missing-overrides.json');
      const f = stubFetch(responder);
      const days = makeDays();
      const out = await addSubjects(days, { cachePath, overridesPath, fetchImpl: f, delayMs: 0, log: quiet });
      assert.equal(out, days); // mutated and returned
      assert.deepEqual(days[0].changes[0].subjects, [{ name: 'Judgement of Command', type: 'spell', kind: 'spell', class: null, tree: null, icon: 'ability_warrior_innerrage', source: 'wowhead' }]);
      assert.deepEqual(days[0].changes[1].subjects, [{ name: 'Taran Icebreaker', type: 'item', kind: 'item', class: null, tree: null, icon: 'inv_mace_13', source: 'wowhead' }]);
      assert.deepEqual(days[0].changes[2].subjects, []);
      // Misses for "Lesser Rock Elemental" and its shrunk variants were tried once each.
      const queried = f.calls.map((c) => c.q);
      assert.ok(queried.includes('Rock Elemental'));
      assert.ok(queried.includes('Elemental') === false); // generic single word is skipped

      const written = await readFile(cachePath, 'utf8');
      const parsed = JSON.parse(written);
      assert.deepEqual(Object.keys(parsed), Object.keys(parsed).slice().sort());
      assert.equal(parsed['lesser rock elemental'], null);
      assert.equal(parsed['taran icebreaker'].icon, 'inv_mace_13');
      assert.ok(written.startsWith('{\n  "'));
      assert.ok(written.endsWith('}\n'));

      // Second run: everything is cached, so no fetch at all.
      const f2 = stubFetch(() => { throw new Error('should not be called'); });
      const again = makeDays();
      await addSubjects(again, { cachePath, overridesPath, fetchImpl: f2, delayMs: 0, log: quiet });
      assert.equal(f2.calls.length, 0);
      assert.deepEqual(again[0].changes[0].subjects, days[0].changes[0].subjects);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('overrides file wins and is never modified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'icons-test-'));
    try {
      const overridesPath = join(dir, 'overrides.json');
      const overrideText = JSON.stringify({
        'judgement of command': { name: 'Judgement of Command', type: 'spell', icon: 'custom_icon' },
        'taran icebreaker': null,
      });
      await writeFile(overridesPath, overrideText);
      const f = stubFetch(responder);
      const days = makeDays();
      await addSubjects(days, { cachePath: join(dir, 'c.json'), overridesPath, fetchImpl: f, delayMs: 0, log: quiet });
      assert.equal(days[0].changes[0].subjects[0].icon, 'custom_icon');
      assert.deepEqual(days[0].changes[1].subjects, []);
      assert.ok(!f.calls.some((c) => /Judgement of Command|Taran Icebreaker/.test(c.q)));
      assert.equal(await readFile(overridesPath, 'utf8'), overrideText);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('never throws on network failure; failures are not cached; breaker stops calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'icons-test-'));
    try {
      const cachePath = join(dir, 'c.json');
      let n = 0;
      const boom = async () => { n++; throw new Error('offline'); };
      const days = makeDays();
      await addSubjects(days, { cachePath, overridesPath: join(dir, 'o.json'), fetchImpl: boom, delayMs: 0, log: quiet });
      assert.ok(n <= 5);
      assert.ok(days[0].changes.every((c) => Array.isArray(c.subjects) && c.subjects.length === 0));
      assert.deepEqual(JSON.parse(await readFile(cachePath, 'utf8')), {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('respects maxLookups across the whole run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'icons-test-'));
    try {
      const f = stubFetch(responder);
      await addSubjects(makeDays(), { cachePath: join(dir, 'c.json'), overridesPath: join(dir, 'o.json'), fetchImpl: f, delayMs: 0, maxLookups: 1, log: quiet });
      assert.equal(f.calls.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('class-scope lines prefer spells; Items category prefers items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'icons-test-'));
    try {
      const both = () => [item('Sap', 'item_icon'), spell('Sap', 'spell_icon')];
      const days = [{ date: 'd', label: 'd', changes: [
        { id: '1', scope: 'class', category: 'Classes', class: 'rogue', text: 'Sap is fixed.', subjects: [] },
        { id: '2', scope: 'general', category: 'Items', class: null, text: 'Sap is fixed.', subjects: [] },
      ] }];
      // Same name cached after the first lookup, so use two separate cache files.
      await addSubjects([days[0]], { cachePath: join(dir, 'a.json'), overridesPath: join(dir, 'o.json'), fetchImpl: stubFetch(both), delayMs: 0, log: quiet });
      days[0].changes = [days[0].changes[1]];
      await addSubjects(days, { cachePath: join(dir, 'b.json'), overridesPath: join(dir, 'o.json'), fetchImpl: stubFetch(both), delayMs: 0, log: quiet });
      const first = JSON.parse(await readFile(join(dir, 'a.json'), 'utf8'));
      const second = JSON.parse(await readFile(join(dir, 'b.json'), 'utf8'));
      assert.equal(first.sap.type, 'spell');
      assert.equal(second.sap.type, 'item');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. v3: kind / class from breadcrumbs and the match preference
// ---------------------------------------------------------------------------

/** Spell result with a breadcrumb, as the real endpoint returns them. */
const crumb = (name, icon, pinBreadcrumb, extra = {}) => spell(name, icon, { pinBreadcrumb, ...extra });

describe('lookupName: kind and class from the breadcrumb', () => {
  const one = async (result, opts = {}) =>
    lookupName(result.name, { fetchImpl: stubFetch(() => [result]), cache: {}, ...opts });

  test('Talents -> talent, Abilities -> ability, Uncategorized -> spell, class lower-cased', async () => {
    assert.deepEqual(await one(crumb('Oath of Light', 'i1', ['Talents', 'Paladin'])),
      { name: 'Oath of Light', type: 'spell', kind: 'talent', class: 'paladin', icon: 'i1' });
    assert.deepEqual(await one(crumb('Smite', 'i2', ['Abilities', 'Priest'])),
      { name: 'Smite', type: 'spell', kind: 'ability', class: 'priest', icon: 'i2' });
    assert.deepEqual(await one(crumb('Odd', 'i3', ['Uncategorized'])),
      { name: 'Odd', type: 'spell', kind: 'spell', class: null, icon: 'i3' });
    assert.deepEqual(await one(crumb('Odd2', 'i4', ['Uncategorized', 'Warlock'])),
      { name: 'Odd2', type: 'spell', kind: 'spell', class: 'warlock', icon: 'i4' });
  });

  test('items are kind "item"; a class can come from "Requires <Class>" in pinDescription', async () => {
    assert.deepEqual(await one(item('Ring', 'r')), { name: 'Ring', type: 'item', kind: 'item', class: null, icon: 'r' });
    const r = await one(spell('Thing', 't', { pinDescription: 'Requires Rogue. Does things.' }));
    assert.equal(r.class, 'rogue');
    assert.equal(r.kind, 'spell');
  });
});

describe('lookupName: choosing among several exact matches', () => {
  /** The three "Judgement" matches seen on the real endpoint. */
  const judgement = [
    crumb('Judgement', 'ability_pal', ['Abilities', 'Paladin']),
    crumb('Judgement', 'unc1', ['Uncategorized', 'Paladin']),
    crumb('Judgement', 'unc2', ['Uncategorized']),
  ];
  /** "Holy Shield" is both a talent and an ability of the paladin. */
  const holyShield = [
    crumb('Holy Shield', 'abil', ['Abilities', 'Paladin']),
    crumb('Holy Shield', 'tal', ['Talents', 'Paladin']),
  ];
  const pick = (results, name, opts) => lookupName(name, { fetchImpl: stubFetch(() => results), cache: {}, ...opts });

  test('Judgement: the Abilities/Paladin match wins for any asking class', async () => {
    assert.equal((await pick(judgement, 'Judgement', { classSlug: 'paladin' })).icon, 'ability_pal');
    assert.equal((await pick(judgement, 'Judgement', { classSlug: 'rogue' })).icon, 'ability_pal');
    assert.equal((await pick(judgement, 'Judgement')).kind, 'ability');
  });

  test('Holy Shield: the talent beats the ability and keeps kind "talent"', async () => {
    const r = await pick(holyShield, 'Holy Shield', { classSlug: 'paladin' });
    assert.deepEqual([r.kind, r.icon], ['talent', 'tal']);
    assert.equal((await pick(holyShield, 'Holy Shield')).kind, 'talent');
  });

  test('rank 1 (own class) beats rank 2 (other class)', async () => {
    const results = [crumb('Strike', 'war', ['Abilities', 'Warrior']), crumb('Strike', 'rog', ['Abilities', 'Rogue'])];
    assert.equal((await pick(results, 'Strike', { classSlug: 'rogue' })).icon, 'rog');
    assert.equal((await pick(results, 'Strike', { classSlug: 'mage' })).icon, 'war'); // no own class: first
  });

  test('rank 3: an own-class Uncategorized spell beats a generic one', async () => {
    const results = [crumb('Zap', 'gen', ['Uncategorized']), crumb('Zap', 'mine', ['Uncategorized', 'Mage'])];
    assert.equal((await pick(results, 'Zap', { classSlug: 'mage' })).icon, 'mine');
    assert.equal((await pick(results, 'Zap')).icon, 'gen');
  });

  test('NPC Abilities only win when nothing else matches; quests and guides never', async () => {
    const npc = crumb('Bite', 'npc', ['NPC Abilities']);
    assert.equal((await pick([npc, crumb('Bite', 'unc', ['Uncategorized'])], 'Bite')).icon, 'unc');
    assert.equal((await pick([npc], 'Bite')).icon, 'npc');
    const quest = { type: 5, id: 9, name: 'Bite', typeName: 'Quest', icon: 'q', pinBreadcrumb: ['Dungeons'] };
    const guide = { type: 9, id: 8, name: 'Bite', typeName: 'Guide' };
    assert.equal(await pick([quest, guide], 'Bite'), null);
  });

  test('preferType still filters before ranking', async () => {
    const results = [crumb('Sap', 'tal', ['Talents', 'Rogue']), item('Sap', 'it')];
    assert.equal((await pick(results, 'Sap', { preferType: 'item' })).type, 'item');
    assert.equal((await pick(results, 'Sap', { preferType: 'spell' })).type, 'spell');
  });
});

// ---------------------------------------------------------------------------
// 5. v3: cache migration, notes, processing order, game-data index
// ---------------------------------------------------------------------------

/** Run addSubjects in a temp dir with the given cache / overrides contents. */
async function runIn(days, { cache = {}, overrides = {}, ...opts } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'icons-v3-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const overridesPath = join(dir, 'overrides.json');
    await writeFile(cachePath, JSON.stringify(cache));
    await writeFile(overridesPath, JSON.stringify(overrides));
    await addSubjects(days, { cachePath, overridesPath, delayMs: 0, log: quiet, ...opts });
    return JSON.parse(await readFile(cachePath, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One-change day helper. */
const oneDay = (change, date = '2026-11-13') => [{ date, changes: [{ id: 'x', scope: 'class', category: 'Classes', class: null, notes: [], subjects: [], ...change }] }];

describe('addSubjects: notes, cache migration and ordering', () => {
  test('subjects come from the text first, then the notes, de-duplicated', async () => {
    const days = oneDay({
      class: 'shaman', text: 'Windfury Totem is now activated by all melee abilities.',
      notes: ['Developers’ notes: Abilities like Whirlwind or Mutilate do not proc Windfury Totem.'],
    });
    const f = stubFetch((q) => [crumb(q, `ic_${q.replace(/ /g, '')}`, ['Abilities', 'Shaman'])]);
    await runIn(days, { fetchImpl: f });
    assert.deepEqual(days[0].changes[0].subjects.map((s) => s.name), ['Windfury Totem', 'Whirlwind', 'Mutilate']);
    assert.equal(f.calls.filter((c) => c.q === 'Windfury Totem').length, 1);
  });

  test('a change has at most 8 subjects', async () => {
    const names = ['Aa', 'Bb', 'Cc', 'Dd', 'Ee', 'Ff'];
    const days = oneDay({ text: `${names.join(', ')}.`, notes: ['Gg, Hh, Ii and Jj changed.'] });
    await runIn(days, { fetchImpl: stubFetch((q) => [spell(q, 'i')]) });
    assert.equal(days[0].changes[0].subjects.length, 8);
  });

  test('old-shape spell hits are used at once and refreshed when budget allows; old items need no call', async () => {
    const days = oneDay({ class: 'paladin', text: 'Holy Shield and Ring of Fire changed. Taran Icebreaker too.' });
    const cache = {
      'holy shield': { name: 'Holy Shield', type: 'spell', icon: 'old_icon' },
      'ring of fire': { name: 'Ring of Fire', type: 'item', icon: 'ring' },
      'taran icebreaker': { name: 'Taran Icebreaker', type: 'item', icon: 'mace' },
      'misses stay': null,
    };
    const f = stubFetch((q) => (q === 'Holy Shield' ? [crumb('Holy Shield', 'new_icon', ['Talents', 'Paladin'])] : []));
    const out = await runIn(days, { cache, fetchImpl: f });
    assert.deepEqual(f.calls.map((c) => c.q), ['Holy Shield']); // only the stale spell is re-fetched
    assert.deepEqual(out['holy shield'], { name: 'Holy Shield', type: 'spell', kind: 'talent', class: 'paladin', icon: 'new_icon' });
    assert.equal(out['ring of fire'].icon, 'ring'); // item entries untouched in the cache
    assert.equal(out['misses stay'], null);
    const subs = days[0].changes[0].subjects;
    assert.deepEqual(subs.map((s) => [s.name, s.kind]), [['Holy Shield', 'talent'], ['Ring of Fire', 'item'], ['Taran Icebreaker', 'item']]);
  });

  test('stale entries keep working when the budget is 0 (kind spell, class null)', async () => {
    const days = oneDay({ text: 'Sap is fixed.' });
    const f = stubFetch(() => { throw new Error('no network expected'); });
    const out = await runIn(days, { cache: { sap: { name: 'Sap', type: 'spell', icon: 'old' } }, fetchImpl: f, maxLookups: 0 });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(out.sap, { name: 'Sap', type: 'spell', icon: 'old' }); // not rewritten
    const s = days[0].changes[0].subjects[0];
    assert.deepEqual([s.kind, s.class, s.icon], ['spell', null, 'old']);
  });

  test('a refresh that finds nothing keeps the old icon in the new shape', async () => {
    const days = oneDay({ text: 'Sap is fixed.' });
    const out = await runIn(days, { cache: { sap: { name: 'Sap', type: 'spell', icon: 'old' } }, fetchImpl: stubFetch(() => []) });
    assert.deepEqual(out.sap, { name: 'Sap', type: 'spell', kind: 'spell', class: null, icon: 'old' });
  });

  test('budget goes to never-looked-up names first, class lines before general lines, then to stale refreshes', async () => {
    const days = [
      { date: '2026-11-13', changes: [
        { id: 'g1', scope: 'general', category: 'Items', class: null, text: 'Gengen is fixed.', notes: [], subjects: [] },
        { id: 'c1', scope: 'class', category: 'Classes', class: 'mage', text: 'Classnew is fixed.', notes: [], subjects: [] },
      ] },
      { date: '2026-11-12', changes: [
        { id: 'c0', scope: 'class', category: 'Classes', class: 'mage', text: 'Classold is fixed.', notes: [], subjects: [] },
        { id: 's0', scope: 'class', category: 'Classes', class: 'mage', text: 'Stalespell is fixed.', notes: [], subjects: [] },
      ] },
    ];
    const cache = { stalespell: { name: 'Stalespell', type: 'spell', icon: 'o' } };
    const f = stubFetch((q) => [spell(q, 'i')]);
    await runIn(days, { cache, fetchImpl: f, maxLookups: 3 });
    // newest class line, older class line, then the general line; the stale refresh gets nothing
    assert.deepEqual(f.calls.map((c) => c.q), ['Classnew', 'Classold', 'Gengen']);
    const f2 = stubFetch((q) => [spell(q, 'i')]);
    await runIn(structuredClone(days), { cache, fetchImpl: f2, maxLookups: 4 });
    assert.deepEqual(f2.calls.map((c) => c.q), ['Classnew', 'Classold', 'Gengen', 'Stalespell']);
  });

  test('"Slice and Dice": the whole name is tried first, the parts only on a miss', async () => {
    const hitWhole = oneDay({ class: 'rogue', text: 'Slice and Dice now lasts longer.' });
    const f = stubFetch((q) => (q === 'Slice and Dice' ? [crumb(q, 'snd', ['Abilities', 'Rogue'])] : []));
    await runIn(hitWhole, { fetchImpl: f });
    assert.deepEqual(hitWhole[0].changes[0].subjects.map((s) => s.name), ['Slice and Dice']);
    assert.deepEqual(f.calls.map((c) => c.q), ['Slice and Dice']);

    const parts = oneDay({ class: 'rogue', text: 'Rupture and Garrote now refresh.' });
    const f2 = stubFetch((q) => (q === 'Rupture' || q === 'Garrote' ? [spell(q, `i_${q}`)] : []));
    await runIn(parts, { fetchImpl: f2 });
    assert.deepEqual(parts[0].changes[0].subjects.map((s) => s.name), ['Rupture', 'Garrote']);
  });

  test('overrides may carry kind / class / tree', async () => {
    const days = oneDay({ text: 'Unsealed Fury no longer echoes.' });
    await runIn(days, { fetchImpl: stubFetch(() => []), overrides: {
      'unsealed fury': { name: 'Unsealed Fury', type: 'spell', kind: 'talent', class: 'paladin', tree: 'retribution', icon: 'ic' } } });
    assert.deepEqual(days[0].changes[0].subjects[0],
      { name: 'Unsealed Fury', type: 'spell', kind: 'talent', class: 'paladin', tree: 'retribution', icon: 'ic', source: 'override' });
  });
});

/** A stub game-data index over a plain object keyed by lower-case name. */
function stubIndex(table, calls = []) {
  return {
    calls,
    lookup(name, opts) {
      calls.push([name, opts]);
      return table[name.toLowerCase()] ?? null;
    },
  };
}
const clientHit = (name, icon, extra = {}) => ({ name, type: 'spell', kind: 'ability', class: 'rogue', tree: null, icon, ...extra });

describe('addSubjects with a game-data index', () => {
  test('null index: everything comes from Wowhead (source "wowhead", tree null)', async () => {
    const days = oneDay({ text: 'Sap is fixed.' });
    await runIn(days, { fetchImpl: stubFetch((q) => [spell(q, 'w')]), gameIndex: null });
    assert.deepEqual(days[0].changes[0].subjects[0], { name: 'Sap', type: 'spell', kind: 'spell', class: null, tree: null, icon: 'w', source: 'wowhead' });
  });

  test('source order: override, then client, then Wowhead; the client costs no network', async () => {
    const days = oneDay({ class: 'rogue', text: 'Ambush, Gouge and Kick changed.' });
    const index = stubIndex({ ambush: clientHit('Ambush', 'ab_client'), gouge: clientHit('Gouge', 'gouge_client') });
    const f = stubFetch((q) => [spell(q, `${q}_wh`)]);
    await runIn(days, { fetchImpl: f, gameIndex: index, maxLookups: 0,
      overrides: { gouge: { name: 'Gouge', type: 'spell', icon: 'gouge_override' } } });
    const subs = days[0].changes[0].subjects;
    assert.deepEqual(subs.map((s) => [s.name, s.source, s.icon]),
      [['Ambush', 'client', 'ab_client'], ['Gouge', 'override', 'gouge_override']]); // Kick: unknown, no budget
    assert.equal(f.calls.length, 0);
    assert.deepEqual(index.calls[0][1], { classSlug: 'rogue', preferType: 'spell' });
  });

  test('a name unknown to the client falls back to Wowhead', async () => {
    const days = oneDay({ class: 'rogue', text: 'Ambush, Shank changed.' });
    const index = stubIndex({ ambush: clientHit('Ambush', 'ab') });
    await runIn(days, { fetchImpl: stubFetch((q) => [spell(q, 'wh')]), gameIndex: index, maxLookups: 1 });
    // budget of 1: Shank (unknown to the client) is looked up, Ambush's cross-check has to wait
    assert.deepEqual(days[0].changes[0].subjects.map((s) => [s.name, s.source, s.verified]),
      [['Ambush', 'client', undefined], ['Shank', 'wowhead', undefined]]);
  });

  test('verified: true when icons agree (case-insensitive), false when they differ, absent without a Wowhead answer', async () => {
    const days = oneDay({ class: 'rogue', text: 'Ambush, Gouge and Kick changed.' });
    const index = stubIndex({ ambush: clientHit('Ambush', 'AB_Icon'), gouge: clientHit('Gouge', 'g_client'), kick: clientHit('Kick', 'k') });
    const logs = [];
    const cache = {
      ambush: { name: 'Ambush', type: 'spell', kind: 'ability', class: 'rogue', icon: 'ab_icon' },
      gouge: { name: 'Gouge', type: 'spell', kind: 'ability', class: 'rogue', icon: 'g_wowhead' },
    };
    await runIn(days, { cache, fetchImpl: stubFetch(() => { throw new Error('offline'); }), gameIndex: index, log: (m) => logs.push(m) });
    const [a, g, k] = days[0].changes[0].subjects;
    assert.equal(a.verified, true);
    assert.equal(g.verified, false);
    assert.equal(g.icon, 'g_client'); // the client icon is kept
    assert.ok(!('verified' in k));
    assert.equal(logs.filter((m) => /mismatch/.test(m)).length, 1);
  });

  test('budget order: unknown-to-client first, then at most 100 verifications, then stale refreshes', async () => {
    const names = Array.from({ length: 105 }, (_, i) => `Cn${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    const days = [{ date: '2026-11-13', changes: [
      ...names.map((n, i) => ({ id: `c${i}`, scope: 'class', category: 'Classes', class: 'rogue', text: `${n} changed.`, notes: [], subjects: [] })),
      { id: 'u', scope: 'class', category: 'Classes', class: 'rogue', text: 'Unknownx changed.', notes: [], subjects: [] },
      { id: 's', scope: 'class', category: 'Classes', class: 'rogue', text: 'Stalex changed.', notes: [], subjects: [] },
    ] }];
    const table = Object.fromEntries(names.map((n) => [n.toLowerCase(), clientHit(n, 'c')]));
    const f = stubFetch((q) => [spell(q, 'w')]);
    await runIn(days, { fetchImpl: f, gameIndex: stubIndex(table), maxLookups: 1000,
      cache: { stalex: { name: 'Stalex', type: 'spell', icon: 'o' } } });
    const q = f.calls.map((c) => c.q);
    assert.equal(q[0], 'Unknownx'); // unknown to the client: first
    assert.equal(q.length, 1 + 100 + 1); // then exactly 100 verifications, then the stale refresh
    assert.ok(q.slice(1, 101).every((n) => names.includes(n)));
    assert.equal(q[101], 'Stalex');
  });

  test('a throwing index is treated as "not found"', async () => {
    const days = oneDay({ text: 'Sap is fixed.' });
    const index = { lookup() { throw new Error('boom'); } };
    await runIn(days, { fetchImpl: stubFetch((q) => [spell(q, 'w')]), gameIndex: index });
    assert.equal(days[0].changes[0].subjects[0].source, 'wowhead');
  });
});
