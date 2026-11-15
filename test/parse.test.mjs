/**
 * test/parse.test.mjs — unit tests for scripts/parse.mjs.
 *
 * Grouped by concern: text/slug/date helpers, the full fixture
 * (test/fixtures/hotfixes-sample.html, synthetic wording in the real post's
 * markup shape), list-walking edge cases, developer-note handling, heading
 * variants, and the <script> fallback used when the DOM has no date headings.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanText, slugify, parseDateLabel, parseHotfixHtml, isDeveloperNote, findArticleHtmlInScripts,
} from '../scripts/parse.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/hotfixes-sample.html', import.meta.url), 'utf8');

/** Wrap list markup in one dated day with the given category heading. */
function day(category, listHtml, label = 'November 13, 2026') {
  return `<hr><p><strong>${label}</strong></p><p><strong>${category}</strong></p>${listHtml}`;
}

/** All changes of a parse result, flattened across days. */
function changes(result) {
  return result.days.flatMap((d) => d.changes);
}

/** Project a change onto the fields most tests care about. */
function brief(c) {
  return { scope: c.scope, category: c.category, class: c.class, spec: c.spec, group: c.group, text: c.text, notes: c.notes };
}

describe('helpers', () => {
  test('cleanText collapses whitespace including nbsp and newlines', () => {
    assert.equal(cleanText('  a\n\t b  c  '), 'a b c');
    assert.equal(cleanText(undefined), '');
  });

  test('slugify produces schema-style slugs', () => {
    assert.equal(slugify('Retribution'), 'retribution');
    assert.equal(slugify('Beast Mastery'), 'beast-mastery');
    assert.equal(slugify('  Death  Knight '), 'death-knight');
    assert.equal(slugify('Bob’s Spec'), 'bobs-spec');
    assert.equal(slugify('Démon-Hunter!'), 'demon-hunter');
  });

  test('parseDateLabel converts published labels to ISO dates', () => {
    assert.equal(parseDateLabel('November 13, 2026'), '2026-11-13');
    assert.equal(parseDateLabel('January 2, 2027'), '2027-01-02');
    assert.equal(parseDateLabel(' Nov. 3rd 2026 '), '2026-11-03');
    assert.equal(parseDateLabel('Sept 9, 2026'), '2026-09-09');
  });

  test('parseDateLabel rejects non-dates and impossible dates', () => {
    assert.equal(parseDateLabel('Classes'), null);
    assert.equal(parseDateLabel('Hotfixes'), null);
    assert.equal(parseDateLabel('Smarch 1, 2026'), null);
    assert.equal(parseDateLabel('February 30, 2026'), null);
    assert.equal(parseDateLabel('November 13, 2026 and more'), null);
  });
});

describe('fixture: hotfixes-sample.html', () => {
  const result = parseHotfixHtml(FIXTURE);

  test('finds both days, newest first, with ISO dates and published labels', () => {
    assert.deepEqual(result.days.map((d) => [d.date, d.label, d.changes.length]), [
      ['2026-11-13', 'November 13, 2026', 10],
      ['2026-11-11', 'November 11, 2026', 3],
    ]);
  });

  test('every change matches the schema shape', () => {
    const keys = ['id', 'scope', 'category', 'class', 'spec', 'group', 'text', 'notes', 'subjects'];
    for (const d of result.days) {
      d.changes.forEach((c, i) => {
        assert.deepEqual(Object.keys(c).sort(), [...keys].sort());
        assert.equal(c.id, `${d.date}-${String(i + 1).padStart(3, '0')}`);
        assert.ok(['class', 'general'].includes(c.scope));
        assert.ok(Array.isArray(c.notes));
        assert.deepEqual(c.subjects, []);
        assert.notEqual(c.text, '');
      });
    }
  });

  test('November 13 changes in published order', () => {
    const cls = (klass, spec, text, notes = []) => ({ scope: 'class', category: 'Classes', class: klass, spec, group: null, text, notes });
    const gen = (category, group, text) => ({ scope: 'general', category, class: null, spec: null, group, text, notes: [] });
    assert.deepEqual(result.days[0].changes.map(brief), [
      cls(null, null, 'Fixed a bug with diminishing returns on creature stuns.'),
      cls('druid', 'restoration', 'Wild Growth can no longer be cast while moving.'),
      cls('druid', 'restoration', 'Wild Growth healing coefficient increased to 6.6% (was 3.3%).'),
      cls('paladin', null, 'Judgement of Command now counts as a melee attack.',
        ['Developers’ notes: Other judgements stay ranged.']),
      cls('priest', null, 'The Legacy Perk The Quick and the Dead now reduces the Mana cost of Divine Spirit.'),
      cls('shaman', null, 'Windfury Totem is now activated by all melee abilities.',
        ["Developers' notes: Offhand strikes still cannot activate it."]),
      gen('Dungeons', null, 'Trivial enemies in dungeons now award no experience.'),
      gen('Dungeons', 'The Deadmines', 'Sneed now ejects properly when the Shredder is stunned.'),
      gen('Items', null, 'Taran Icebreaker now behaves as a 2-handed Mace (was 1-handed).'),
      gen('Items', null, 'Everstaring Abomination Eye’s Spirit stats corrected.'),
    ]);
  });

  test('November 11 changes: class line then spec line, then a quest', () => {
    assert.deepEqual(result.days[1].changes.map((c) => [c.id, c.scope, c.category, c.class, c.spec, c.text]), [
      ['2026-11-11-001', 'class', 'Classes', 'paladin', null, 'Judgement is now considered a Ranged Attack.'],
      ['2026-11-11-002', 'class', 'Classes', 'paladin', 'retribution', 'Unsealed Fury no longer generates echoes from Windfury Totem attacks.'],
      ['2026-11-11-003', 'general', 'Quests', null, null, 'Fixed an issue with the quest "Helping Hands."'],
    ]);
  });

  test('intro paragraph and "Hotfixes" heading are not treated as content', () => {
    assert.ok(!changes(result).some((c) => /list of hotfixes/.test(c.text) || c.category === 'Hotfixes'));
  });
});
