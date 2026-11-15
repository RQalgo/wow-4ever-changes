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
    assert.deepEqual(r, { name: "Hunter's Mark", type: 'spell', icon: 'ability_hunter_snipershot' });
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
      spell('Judgement', 'icon_paladin', { pinDescription: 'Paladin ability' }),
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
    assert.deepEqual(cache.sap, { name: 'Sap', type: 'spell', icon: 'ability_sap' });
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
      assert.deepEqual(days[0].changes[0].subjects, [{ name: 'Judgement of Command', type: 'spell', icon: 'ability_warrior_innerrage' }]);
      assert.deepEqual(days[0].changes[1].subjects, [{ name: 'Taran Icebreaker', type: 'item', icon: 'inv_mace_13' }]);
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
