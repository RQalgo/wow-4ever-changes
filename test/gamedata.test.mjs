// test/gamedata.test.mjs
//
// Unit tests for scripts/gamedata.mjs. Nothing touches the network: every
// download goes through a stubbed `fetchImpl` serving the small CSV fixtures in
// test/fixtures/gamedata/. Run with `node --test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classFromMask, normalizeName, treeSlug } from '../scripts/gamedata.mjs';

describe('helpers', () => {
  test('classFromMask: single bits map to classes, everything else to null', () => {
    assert.equal(classFromMask(1), 'warrior');
    assert.equal(classFromMask('128'), 'mage');
    assert.equal(classFromMask(1024), 'druid');
    assert.equal(classFromMask(3), null); // warrior + paladin
    assert.equal(classFromMask(0), null);
    assert.equal(classFromMask('abc'), null);
    assert.equal(classFromMask(32), null); // death knight does not exist here
  });

  test('normalizeName: case, curly apostrophes, whitespace', () => {
    assert.equal(normalizeName('  Hunter’s   Mark '), "hunter's mark");
    assert.equal(normalizeName(undefined), '');
  });

  test('treeSlug', () => {
    assert.equal(treeSlug('Beast Mastery'), 'beast-mastery');
    assert.equal(treeSlug('Feral Combat'), 'feral');
    assert.equal(treeSlug('Frost'), 'frost');
  });
});
