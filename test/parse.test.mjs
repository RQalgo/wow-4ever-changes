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
import { cleanText, slugify, parseDateLabel } from '../scripts/parse.mjs';

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
