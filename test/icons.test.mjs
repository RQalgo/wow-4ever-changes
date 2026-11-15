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

import { extractCandidates } from '../scripts/icons.mjs';

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
    ['Sap and Gouge now share diminishing returns.', ['Sap and Gouge']],
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

  test('is capped at 4 candidates and de-duplicated in order', () => {
    const got = extractCandidates('Sap, Gouge, Kick, Evasion, Vanish and Sap again, plus Garrote.');
    assert.equal(got.length, 4);
    assert.deepEqual(got, ['Sap', 'Gouge', 'Kick', 'Evasion']);
    assert.deepEqual(extractCandidates('Sap now works. Sap is great.'), ['Sap']);
  });

  test('class and spec names alone are not candidates', () => {
    assert.deepEqual(extractCandidates('Retribution Paladin changes.'), []);
    assert.deepEqual(extractCandidates('Rogues and Warriors are happier.'), []);
  });

  test('classSlug option is accepted', () => {
    assert.deepEqual(extractCandidates('Sap is fixed.', { classSlug: 'rogue' }), ['Sap']);
  });
});
