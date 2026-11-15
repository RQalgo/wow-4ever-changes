// test/gamedata.test.mjs
//
// Unit tests for scripts/gamedata.mjs. Nothing touches the network: every
// download goes through a stubbed `fetchImpl` serving the small CSV fixtures in
// test/fixtures/gamedata/. Run with `node --test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classFromMask, normalizeName, treeSlug, parseCsv, csvRows } from '../scripts/gamedata.mjs';

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

describe('parseCsv', () => {
  test('plain rows keyed by header', () => {
    assert.deepEqual(parseCsv('ID,Name_lang\n10,Blizzard\n11,Frostbolt\n'), [
      { ID: '10', Name_lang: 'Blizzard' },
      { ID: '11', Name_lang: 'Frostbolt' },
    ]);
  });

  test('quoted commas, colons, doubled quotes and embedded newlines', () => {
    const rows = parseCsv('ID,Name_lang\n17,"Power Word: Shield"\n18,"Smith, John"\n19,"say ""hi"""\n20,"two\nlines"\n');
    assert.deepEqual(rows.map((r) => r.Name_lang), ['Power Word: Shield', 'Smith, John', 'say "hi"', 'two\nlines']);
  });

  test('CRLF, lone CR, blank lines, no trailing newline', () => {
    assert.equal(parseCsv('a,b\r\n1,2\r\n\r\n3,4').length, 2);
    assert.deepEqual(parseCsv('a,b\r1,2\r3,4\r'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  test('empty fields, short rows and a BOM', () => {
    assert.deepEqual(parseCsv('\uFEFFa,b,c\n1,,3\n,,\n4\n'), [
      { a: '1', b: '', c: '3' },
      { a: '', b: '', c: '' },
      { a: '4', b: '', c: '' },
    ]);
  });

  test('empty quoted field is kept as an empty value, stray quote stays literal', () => {
    assert.deepEqual(parseCsv('a,b\n"",x\n5" tall,y\n'), [{ a: '', b: 'x' }, { a: '5" tall', b: 'y' }]);
  });

  test('columns option keeps only wanted columns; required throws when absent', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,2,3\n', { columns: ['a', 'c'] }), [{ a: '1', c: '3' }]);
    assert.throws(() => parseCsv('a,b\n1,2\n', { required: ['SpellID'] }), /missing column "SpellID"/);
  });

  test('header only / empty input give no rows', () => {
    assert.deepEqual(parseCsv('a,b\n'), []);
    assert.deepEqual(parseCsv(''), []);
  });
});

describe('csvRows (streaming)', () => {
  const text = 'ID,Name_lang\r\n1,"A, ""B"""\r\n2,"x\ny"\r\n3,\u00e9t\u00e9\r\n4,last';
  const expected = parseCsv(text);

  /** Collects all rows of an async generator. */
  async function collect(gen) {
    const out = [];
    for await (const r of gen) out.push(r);
    return out;
  }

  test('a string source gives the same rows as parseCsv', async () => {
    assert.deepEqual(await collect(csvRows(text)), expected);
  });

  test('splitting the text at every possible position never changes the result', async () => {
    for (let cut = 1; cut < text.length; cut++) {
      const chunks = [text.slice(0, cut), text.slice(cut)];
      assert.deepEqual(await collect(csvRows(chunks)), expected, `cut at ${cut}`);
    }
  });

  test('one-character chunks work (quote and CRLF straddling chunks)', async () => {
    assert.deepEqual(await collect(csvRows(text.split(''))), expected);
  });

  test('byte chunks that split a multi-byte character', async () => {
    const bytes = Buffer.from(text, 'utf8');
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3));
    assert.deepEqual(await collect(csvRows(chunks)), expected);
  });
});
