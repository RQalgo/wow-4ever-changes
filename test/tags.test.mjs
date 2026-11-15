// test/tags.test.mjs
//
// Unit tests for scripts/tags.mjs (run with `node --test`). Most cases are
// realistic lines taken from data/changes.json; no network, no files.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTags, addTags, classMentions, isNpcOwned } from '../scripts/tags.mjs';

/** Build a change; defaults describe a general line with no subjects. */
const ch = (o) => ({ scope: 'general', category: 'Items', class: null, spec: null, group: null, notes: [], subjects: [], ...o });
/** A class-line shortcut. */
const cls = (klass, spec, text, o = {}) => ch({ scope: 'class', category: 'Classes', class: klass, spec, text, ...o });
/** Subject shortcut. */
const subj = (name, kind, klass, tree = null, type = kind === 'item' ? 'item' : 'spell') => ({ name, type, kind, class: klass, tree, icon: 'i' });

describe('computeTags on realistic lines', () => {
  /** [change, expected tags] */
  const cases = [
    [cls('shaman', 'elemental', 'Elemental Reach: Now also reduces the cooldown on Totemic Projection by 10/20 seconds.'),
      ['class:shaman', 'spec:shaman/elemental']],
    [cls('paladin', null, 'Paladins now also learn Revoke when Salvation is learned. Revoke removes target party or raid member’s Salvation.'),
      ['class:paladin']], // "party or raid member" is not a dungeon
    [cls('druid', null, 'Fixed an issue where Omen of Clarity could not activate after swapping specializations.'),
      ['class:druid', 'bugfix']],
    [cls('mage', 'fire', 'Wake of Fire: Talent reverted back to Improved Fire Blast and no longer grants a bonus when the Mage kills a target.'),
      ['class:mage', 'spec:mage/fire', 'talent']],
    [cls('paladin', null, 'Redoubt can now be tracked in the Cooldown Manager.'), ['class:paladin', 'ui']],
    [cls('paladin', 'retribution', 'Spiritual Focus moved to Row 1 (Was Row 2). Changed to a 5-point talent (Was a 2-point talent).'),
      ['class:paladin', 'spec:paladin/retribution', 'talent']],
    [cls(null, null, 'Learning new spells will no longer cause them to be automatically added to your action bars.'), ['ui']],
    [cls(null, null, 'All classes now gain a little extra Mana at level 10.'), ['other']], // nothing else describes it
    [cls('rogue', null, 'Fixed an issue during the quest "The Talisman of Kazdor" where rogues would enter the wrong version of Zul\'Farrak.'),
      ['class:rogue', 'bugfix', 'dungeons', 'quests']],
    [ch({ category: 'Quests', text: 'Fixed a bug preventing Jom-jom from continuing his escape on “Jom-jom’s Escape”.' }), ['bugfix', 'quests']],
    [ch({ category: 'Quests', text: 'On "A Quick Grocery Run", Skonk\'s list can be read by everyone.' }), ['quests']],
    [ch({ category: 'Quests and World', group: 'Darkshire', text: 'Stitches is once again hostile.' }), ['quests', 'world']],
    [ch({ category: 'Enemies and NPCs', text: 'Durotar - Fixed an issue where Yarrog Baneshadow was respawning more slowly than intended.' }), ['bugfix', 'world']],
    [ch({ category: 'Items', text: 'Fixed an issue where trade supply vendors on Zephras Isle didn\'t sell apprentice tradeskill bags.' }), ['bugfix', 'items']],
    [ch({ category: 'Items', text: 'Channeler\'s Ring now has Spell Power (was Spirit).', subjects: [subj('Channeler\'s Ring', 'item', null)],
      notes: ['Developers’ notes: Until raids open, this exchange will be the first item on the vendor list.'] }), ['items']],
    [ch({ category: 'Dungeons', group: 'The Deadmines', text: 'Killing enemies in dungeons now awards zero experience.' }), ['dungeons']],
    [ch({ category: 'Enemies and NPCs', group: 'Gnomeregan', text: 'Techbot\'s respawn time reduced for the quest "Save Techbot\'s Brain!"' }), ['dungeons', 'quests', 'world']],
    [ch({ category: 'Player versus Player', text: 'Plainsrunning can no longer stack when carrying a flag in a battleground.' }), ['pvp']],
    [ch({ category: 'Changes and Updates', group: 'Gamepad Support', text: 'Gamepad Action Bar settings have been moved into edit mode.' }), ['ui']],
    [ch({ category: 'Gamepad Support', text: 'Added a swing timer to the center reticle.' }), ['ui']],
    [ch({ category: 'User Interface and Accessibility', text: 'Tooltips now show more.' }), ['ui']],
    [ch({ category: 'Cooldown Manager', text: 'Pet cooldowns can be tracked.' }), ['ui']],
    [ch({ category: 'Races', group: 'Tauren', text: 'Endurance now works as intended.' }), ['races']],
    [ch({ category: 'Racial Abilities and Traits', text: 'Ruthless now increases critical chance by 1% (was 2%).' }), ['races']],
    [ch({ category: 'Professions', group: 'Cooking', text: 'Fish Fillet now sells for more.' }), ['professions']],
    [ch({ category: 'Changes and Updates', text: 'Improved the weekly fishing tournament by increasing the number of winners.' }), ['professions']],
    [ch({ category: 'Stranglethorn Fishing Extravaganza', text: 'The event now runs on Sundays.' }), ['events']],
    [ch({ category: 'Legacy System', text: 'All Beta players have been granted completion of the Legacy Challenge.' }), ['systems']],
    [ch({ category: 'Bugfixes', text: 'Fixed an issue that made a rune ability visible.' }), ['bugfix']],
    [ch({ category: 'Bug Fixes', text: 'Resolved a crash.' }), ['bugfix']],
    [ch({ category: 'Known Issues – New with this build', text: 'Pet cooldowns cannot be tracked.' }), ['known-issue']],
    [ch({ category: 'New to this build - Known Issues', text: 'Healthstone cooldown cannot be tracked.' }), ['known-issue']],
    [ch({ category: 'Customer Support', text: 'The Item Restoration service has been disabled while we investigate a critical bug.' }), ['other']],
    [ch({ category: 'General', text: 'Something entirely new.' }), ['other']],
    [ch({ category: 'Changes and Updates', text: 'Added a new tutorial experience for new players.' }), ['other']],
    // class words as names of NPCs are not class tags
    [ch({ category: 'Quests', text: 'The Novice Warriors will no longer flag players for PvP during the quest “Sparring Match”.' }), ['pvp', 'quests']],
    [ch({ category: 'Races', text: 'Tauren Warriors now start with the correct +5 strength.' }), ['races']],
    [ch({ category: 'Quests', text: 'The Shaman quest reward is now a ring.' }), ['class:shaman', 'quests']],
    [ch({ category: 'Items', text: 'Priests and Mages can now wear it. Rogues cannot.' }), ['class:mage', 'class:priest', 'class:rogue', 'items']],
  ];
  for (const [change, expected] of cases) {
    test(`${change.category}: ${change.text.slice(0, 55)}`, () => assert.deepEqual(computeTags(change), expected));
  }
});

describe('computeTags: classes, specs, talents from subjects', () => {
  test('class order: published first, then alphabetical; spec; talent; categories', () => {
    const c = cls('shaman', null, 'Windfury Totem is now activated by all melee abilities.', {
      notes: ['Developers’ notes: abilities like Whirlwind or Mutilate do not proc it.'],
      subjects: [subj('Windfury Totem', 'ability', 'shaman'), subj('Whirlwind', 'ability', 'warrior'), subj('Mutilate', 'talent', 'rogue', 'assassination')],
    });
    assert.deepEqual(computeTags(c), ['class:shaman', 'class:rogue', 'class:warrior', 'spec:rogue/assassination', 'talent']);
  });

  test('a talent subject with a tree adds spec:<class>/<tree> after the published spec', () => {
    const c = cls('paladin', 'holy', 'Oath of Light and Unsealed Fury changed.', {
      subjects: [subj('Unsealed Fury', 'talent', 'paladin', 'retribution'), subj('Oath of Light', 'talent', 'paladin', 'holy')],
    });
    assert.deepEqual(computeTags(c), ['class:paladin', 'spec:paladin/holy', 'spec:paladin/retribution', 'talent']);
  });

  test('abilities and non-class subjects add no spec; spells without class add no class', () => {
    const c = cls('mage', null, 'Frostbolt is better.', { subjects: [subj('Frostbolt', 'ability', 'mage', 'frost'), subj('Odd', 'spell', 'rogue')] });
    assert.deepEqual(computeTags(c), ['class:mage']);
  });

  test('talent text rules: "talent", "Row 4"', () => {
    assert.deepEqual(computeTags(cls('priest', null, 'New Talent Spirit Tap added to Row 4.')), ['class:priest', 'talent']);
    assert.deepEqual(computeTags(cls('priest', null, 'The talent now works.')), ['class:priest', 'talent']);
  });

  test('item subjects add "items"; a class line can get quests / pvp / professions', () => {
    assert.deepEqual(computeTags(cls('rogue', null, 'Sap works in battlegrounds.')), ['class:rogue', 'pvp']);
    assert.deepEqual(computeTags(cls('hunter', null, 'The Hunter class quest now rewards Taran Icebreaker.', { subjects: [subj('Taran Icebreaker', 'item', null)] })),
      ['class:hunter', 'items', 'quests']);
    assert.deepEqual(computeTags(cls('warrior', null, 'Skinning no longer helps Rend.')), ['class:warrior', 'professions']);
  });

  test('bugfix prefixes: Fixed / Resolved / Corrected / Addressed', () => {
    for (const w of ['Fixed', 'Resolved', 'Corrected', 'Addressed']) {
      assert.ok(computeTags(ch({ text: `${w} an issue with something.` })).includes('bugfix'), w);
    }
    assert.ok(!computeTags(ch({ text: 'The fixed cost is lower.' })).includes('bugfix'));
  });

  test('the "other" tag is dropped when a specific category tag applies', () => {
    assert.deepEqual(computeTags(ch({ category: 'Changes and Updates', text: 'Fishing now gives more skill.' })), ['professions']);
  });

  test('every change gets at least one tag; unknown published class slugs are ignored', () => {
    assert.deepEqual(computeTags(ch({ category: 'Whatever', text: '' })), ['other']);
    assert.deepEqual(computeTags(cls('bard', null, 'x')), ['other']);
  });

  test('is deterministic and does not mutate its input', () => {
    const c = cls('paladin', 'retribution', 'Fixed a quest bug for Rogues.');
    const copy = structuredClone(c);
    assert.deepEqual(computeTags(c), computeTags(c));
    assert.deepEqual(c, copy);
  });
});

describe('classMentions', () => {
  test('capitalised singulars, plurals, possessives and lower-case plurals count', () => {
    assert.deepEqual([...classMentions('The Paladin’s aura and rogues and Warlocks')].sort(), ['paladin', 'rogue', 'warlock']);
  });
  test('lower-case singular, names with capitalised neighbours and quotes do not', () => {
    assert.equal(classMentions('a rogue appears').size, 0);
    assert.equal(classMentions('Novice Warriors and Deathless Priest of the Sun').size, 0);
    assert.equal(classMentions('during “The Hunter’s Mark” quest').size, 0);
    assert.equal(classMentions('Hunter’s Mark is nice').size, 0);
  });
});

describe('addTags', () => {
  test('sets tags on every change of every day and returns the same days', () => {
    const days = [
      { date: '2026-11-13', changes: [cls('mage', null, 'Frost Nova is fixed.'), ch({ category: 'Quests', text: 'Quest text.' })] },
      { date: '2026-11-12', changes: [ch({ category: 'Bugfixes', text: 'Fixed it.' })] },
      { date: '2026-11-11' },
    ];
    const out = addTags(days);
    assert.equal(out, days);
    assert.deepEqual(days[0].changes.map((c) => c.tags), [['class:mage'], ['quests']]);
    assert.deepEqual(days[1].changes[0].tags, ['bugfix']);
  });

  test('re-tagging replaces old tags (rules revised on every run)', () => {
    const days = [{ date: 'd', changes: [{ ...cls('mage', null, 'Frost Nova.'), tags: ['stale', 'old'] }] }];
    assert.deepEqual(addTags(days)[0].changes[0].tags, ['class:mage']);
  });
});

describe('NPC abilities outside Classes', () => {
  test('isNpcOwned: "<Name>\'s <Skill>" and "’s", optional quote; not class owners or pronouns', () => {
    assert.equal(isNpcOwned('Shield Slam', "Reduced the cast frequency of the Deathless Guardian's Shield Slam ability by about 50%."), true);
    assert.equal(isNpcOwned('Fireball', 'Lowered the damage of the Deathless Sorcerer’s Fireball by 25%.'), true);
    assert.equal(isNpcOwned('Smash', 'The Twilight Enforcer\'s "Smash" deals less damage.'), true);
    assert.equal(isNpcOwned('Charge', 'Hogger’s Charge stuns for less time.'), true);
    assert.equal(isNpcOwned('Retribution Aura', 'The Paladin’s Retribution Aura is fixed.'), false);
    assert.equal(isNpcOwned('Hunter’s Mark', 'Hunter’s Mark now lasts longer.'), false);
    assert.equal(isNpcOwned('Fireball', "It's Fireball that hits hard."), false);
    assert.equal(isNpcOwned('Slam', "The Deathless Guardian's Shield Slam is weaker."), false); // whole words only
    assert.equal(isNpcOwned('Fireball', 'Fireball is fine.'), false);
  });

  test('the Deathless Guardian\'s Shield Slam keeps its icon but adds no class or talent tag', () => {
    const c = ch({ category: 'Dungeons', group: 'The Drowned City › Deathless Marrow',
      text: "Reduced the cast frequency of the Deathless Guardian's Shield Slam ability by about 50%.",
      subjects: [subj('Shield Slam', 'talent', 'warrior', 'protection')] });
    assert.deepEqual(computeTags(c), ['dungeons']);
    assert.equal(c.subjects.length, 1); // the subject (icon) stays
  });

  test('the same possessive under Classes still counts (only lines outside Classes are guarded)', () => {
    const c = cls('warrior', null, "The Deathless Guardian's Shield Slam no longer resets.", {
      subjects: [subj('Shield Slam', 'talent', 'warrior', 'protection')] });
    assert.deepEqual(computeTags(c), ['class:warrior', 'spec:warrior/protection', 'talent']);
  });

  test('outside Classes an NPC-ability line is never "talent", even when it says talent', () => {
    const c = ch({ category: 'Dungeons', text: 'The Deathless Sorcerer’s Fireball now ignores the Fire Ward talent.',
      subjects: [subj('Fireball', 'ability', 'mage')] });
    assert.deepEqual(computeTags(c), ['dungeons']);
  });

  test('a player talent named outside Classes still tags class and talent', () => {
    const c = ch({ category: 'Bug Fixes', text: 'Roots from procs now have Diminishing Returns. Includes Entrapment.',
      subjects: [subj('Entrapment', 'talent', 'hunter', 'survival')] });
    assert.deepEqual(computeTags(c), ['class:hunter', 'spec:hunter/survival', 'talent', 'bugfix']);
  });
});
