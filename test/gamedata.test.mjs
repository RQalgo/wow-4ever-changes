// test/gamedata.test.mjs
//
// Unit tests for scripts/gamedata.mjs. Nothing touches the network: every
// download goes through a stubbed `fetchImpl` serving the small CSV fixtures in
// test/fixtures/gamedata/. Run with `node --test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classFromMask, normalizeName, treeSlug, parseCsv, csvRows, pickLatestBuild,
  buildGameIndexData, makeGameIndex,
  parseWowheadTalentData, fetchWowheadTalents, mergeWowheadTalents,
} from '../scripts/gamedata.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/gamedata/', import.meta.url));
/** Reads a fixture file as text. */
const fixture = (name) => readFileSync(FIXTURES + name, 'utf8');
const TABLES = ['TalentTab', 'Talent', 'SkillLine', 'SkillLineAbility', 'SpellName', 'SpellMisc', 'ItemSparse', 'Item', 'ManifestInterfaceData'];

/**
 * Stub fetch serving the fixtures. `overrides` maps a table name (or a URL
 * substring such as 'api/builds') to replacement body text or to a function
 * (url) => Response. `calls` records every requested URL.
 */
function makeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [needle, val] of Object.entries(overrides)) {
      const hit = TABLES.includes(needle) ? String(url).includes(`/db2/${needle}/csv`) : String(url).includes(needle);
      if (hit) {
        return typeof val === 'function' ? val(url) : new Response(val);
      }
    }
    if (String(url).includes('/api/builds')) return new Response(fixture('builds.json'));
    const m = /\/db2\/(\w+)\/csv/.exec(String(url));
    if (m && TABLES.includes(m[1])) return new Response(fixture(`${m[1]}.csv`));
    return new Response('not found', { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}


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

describe('pickLatestBuild', () => {
  const b = (version, created_at, extra = {}) => ({ product: 'wowf', version, created_at, is_bgdl: false, ...extra });

  test('picks the greatest created_at from an unordered array', () => {
    const json = {
      wow: [b('11.0.0.1', '2030-01-01 00:00:00', { product: 'wow' })],
      wowf: [b('1.60.0.1', '2026-10-01 10:00:00'), b('1.60.1.2', '2026-11-12 09:30:00'), b('1.59.9.9', '2026-09-01 00:00:00')],
    };
    assert.equal(pickLatestBuild(json), '1.60.1.2');
  });

  test('ignores background-download builds when a normal one exists', () => {
    const json = { wowf: [b('1.61.0.1', '2026-11-14 00:00:00', { is_bgdl: true }), b('1.60.1.2', '2026-11-12 09:30:00')] };
    assert.equal(pickLatestBuild(json), '1.60.1.2');
  });

  test('uses a bgdl build when it is the only one', () => {
    assert.equal(pickLatestBuild({ wowf: [b('1.61.0.1', '2026-11-14 00:00:00', { is_bgdl: true })] }), '1.61.0.1');
  });

  test('accepts a top-level array and filters by product', () => {
    const arr = [b('1.60.1.2', '2026-11-12 09:30:00'), { product: 'wow', version: '9.9.9.9', created_at: '2099-01-01 00:00:00' }];
    assert.equal(pickLatestBuild(arr), '1.60.1.2');
    assert.equal(pickLatestBuild(arr, 'wow'), '9.9.9.9');
  });

  test('returns null when nothing matches or the input is junk', () => {
    assert.equal(pickLatestBuild({ wow: [b('1', '2026-01-01 00:00:00', { product: 'wow' })] }), null);
    assert.equal(pickLatestBuild({ wowf: [] }), null);
    assert.equal(pickLatestBuild(null), null);
    assert.equal(pickLatestBuild('nope'), null);
    assert.equal(pickLatestBuild({ wowf: [{ product: 'wowf', created_at: 'x' }] }), null);
  });
});

describe('buildGameIndexData', () => {
  /** Builds the fixture index once per call (cheap: a few dozen rows). */
  const build = (overrides) => buildGameIndexData({ fetchImpl: makeFetch(overrides), version: '1.60.1.70938', pauseMs: 0 });

  test('basic shape, one request per table, honest User-Agent and timeout', async () => {
    const f = makeFetch();
    const data = await buildGameIndexData({ fetchImpl: f, version: '1.60.1.70938', pauseMs: 0 });
    assert.equal(data.version, '1.60.1.70938');
    assert.match(data.builtAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(f.calls.length, TABLES.length);
    assert.ok(f.calls.every((c) => c.url.includes('build=1.60.1.70938')));
    assert.ok(f.calls.every((c) => c.init.headers['User-Agent'] === 'wow-4ever-changes/0.1 (+https://github.com/RQalgo/wow-4ever-changes)'));
    assert.ok(f.calls.every((c) => c.init.signal instanceof AbortSignal));
    JSON.parse(JSON.stringify(data)); // plain JSON
  });

  test('talents: ranks sharing a name collapse, tree and class come from the tab', async () => {
    const { spells } = await build();
    assert.deepEqual(spells['improved fireball'], [
      { name: 'Improved Fireball', kind: 'talent', class: 'mage', tree: 'fire', icon: 'spell_fire_fireball02', id: 300, tab: 41, ids: [300, 301] },
    ]);
    // SpellID-only talent, and tree slugs for multi-word / renamed trees
    assert.equal(spells['mortal strike'][0].kind, 'talent');
    assert.equal(spells['mortal strike'][0].tree, 'arms');
    assert.equal(spells['feral charge'][0].tree, 'feral');
    assert.equal(spells['bestial wrath'][0].tree, 'beast-mastery');
    assert.equal(spells['mutilate'][0].class, 'rogue');
  });

  test('a talent on a multi-class tab has class null; on an unknown tab it is just a spell', async () => {
    const { spells } = await build();
    assert.equal(spells['shared talent'][0].kind, 'talent');
    assert.equal(spells['shared talent'][0].class, null);
    assert.equal(spells['orphan talent'][0].kind, 'spell');
  });

  test('abilities: class from the row mask, tree from a tree-named skill line, talent wins', async () => {
    const { spells } = await build();
    const frost = spells['frostbolt'].filter((e) => e.kind === 'ability');
    assert.deepEqual(frost.map((e) => [e.class, e.tree, e.icon, e.id]), [['mage', 'frost', 'spell_frost_frostbolt02', 100]]);
    const heroic = spells['heroic strike'][0];
    assert.deepEqual([heroic.kind, heroic.class, heroic.tree], ['ability', 'warrior', 'arms']);
    assert.equal(spells['mortal strike'].length, 1); // also on the Arms line, but the talent entry wins
    const charge = spells['charge'][0]; // line "Warrior" is not a tree name
    assert.deepEqual([charge.kind, charge.class, charge.tree], ['ability', 'warrior', null]);
    const pws = spells['power word: shield'][0]; // quoted name with a colon
    assert.deepEqual([pws.kind, pws.class, pws.tree], ['ability', 'priest', 'discipline']);
    assert.equal(spells['fear, mass'][0].class, 'priest'); // quoted comma
    assert.equal(spells['hunter\'s mark'][0].name, 'Hunter’s Mark'); // curly apostrophe normalised in the key
  });

  test('non-class skill lines and multi-bit masks give plain spells', async () => {
    const { spells } = await build();
    assert.deepEqual([spells['dodge'][0].kind, spells['dodge'][0].class], ['spell', null]);
    assert.deepEqual([spells['shared thing'][0].kind, spells['shared thing'][0].class], ['spell', null]);
  });

  test('an NPC spell with a class ability name is kept next to it, ability first', async () => {
    const { spells } = await build();
    assert.deepEqual(spells['frostbolt'].map((e) => [e.kind, e.class, e.icon]), [
      ['ability', 'mage', 'spell_frost_frostbolt02'],
      ['spell', null, 'spell_frost_frostbolt'], // question-mark twin (601) was dropped
    ]);
    assert.deepEqual(spells['whirlwind'].map((e) => e.kind), ['ability', 'spell']); // same icon, different kind
  });

  test('test/internal names are dropped, but lookalikes are kept', async () => {
    const { spells } = await build();
    assert.equal(spells['fireball (test)'], undefined);
    assert.equal(spells['[dnt] something'], undefined);
    assert.equal(spells['zzold blast'], undefined);
    assert.ok(spells['pizzazz']); // contains "zz" but is a real name
  });

  test('question-mark icon kept when it is the only one; spells without icon are absent', async () => {
    const { spells } = await build();
    assert.equal(spells['mystery'][0].icon, 'inv_misc_questionmark');
    assert.equal(spells['noicon'], undefined);
  });

  test('SpellMisc: DifficultyID 0 row wins even when listed second', async () => {
    const { spells } = await build();
    assert.equal(spells['frostbolt'][0].icon, 'spell_frost_frostbolt02'); // diff 1 row said ability_whirlwind
  });

  test('SpellMisc without a SpellID column falls back to ID', async () => {
    const misc = 'ID,DifficultyID,SpellIconFileDataID\n100,0,1002\n810,0,1003\n';
    const { spells } = await build({ SpellMisc: misc });
    assert.equal(spells['frostbolt'][0].icon, 'spell_frost_frostbolt02');
    assert.equal(spells['whirlwind'][0].icon, 'ability_whirlwind');
    assert.equal(spells['mutilate'], undefined); // no row for it
  });

  test('icon names: path case and slash styles, extension and case stripped, non-icons ignored', async () => {
    const { spells } = await build();
    assert.equal(spells['windfury totem'][0].icon, 'spell_nature_windfury'); // Interface\ICONS\ + .blp
    assert.equal(spells['frostbolt'][0].icon, 'spell_frost_frostbolt02'); // interface/icons/ lower-case
    assert.equal(spells['whirlwind'][0].icon, 'ability_whirlwind'); // INTERFACE\ICONS\ + .BLP
    assert.equal(spells['improved fireball'][0].icon, 'spell_fire_fireball02'); // Interface/ICONS/
  });

  test('items: de-duplicated by (name, icon); items without icon or Item row are dropped', async () => {
    const { items } = await build();
    assert.deepEqual(items['taran icebreaker'], [{ name: 'Taran Icebreaker', icon: 'inv_sword_04', id: 2000 }]);
    assert.equal(items['worn shortsword'][0].icon, 'inv_sword_01');
    assert.equal(items['windfury totem'][0].icon, 'inv_misc_idol_03');
    for (const n of ['no icon item', 'not in item table', 'unknown icon item']) assert.equal(items[n], undefined);
  });

  test('at most 6 entries per name', async () => {
    const n = 9;
    const names = ['ID,Name_lang', ...Array.from({ length: n }, (_, i) => `${5000 + i},Many`)].join('\n');
    const misc = ['ID,DifficultyID,SpellIconFileDataID,SpellID', ...Array.from({ length: n }, (_, i) => `${i + 1},0,${3000 + i},${5000 + i}`)].join('\n');
    const manifest = ['ID,FilePath,FileName', ...Array.from({ length: n }, (_, i) => `${3000 + i},Interface\\ICONS\\,Icon_${i}.blp`)].join('\n');
    const { spells } = await build({ SpellName: names, SpellMisc: misc, ManifestInterfaceData: manifest });
    assert.equal(spells['many'].length, 6);
    assert.deepEqual(spells['many'].map((e) => e.id), [5000, 5001, 5002, 5003, 5004, 5005]);
  });

  test('a missing column, a bad status or no version rejects', async () => {
    await assert.rejects(build({ Talent: 'ID,Foo\n1,2\n' }), /Talent: missing column "TabID"/);
    await assert.rejects(build({ SpellName: () => new Response('x', { status: 503 }) }), /HTTP 503/);
    await assert.rejects(buildGameIndexData({ fetchImpl: makeFetch(), pauseMs: 0 }), /version is required/);
  });
});

describe('makeGameIndex lookup', () => {
  /** Index over the fixture data. */
  async function index() {
    return makeGameIndex(await buildGameIndexData({ fetchImpl: makeFetch(), version: '1.60.1.70938', pauseMs: 0 }));
  }

  test('version and size', async () => {
    const idx = await index();
    assert.equal(idx.version, '1.60.1.70938');
    assert.ok(idx.size > 20);
  });

  test('result shape, name normalisation', async () => {
    const idx = await index();
    assert.deepEqual(idx.lookup('  HUNTER’S   mark '), {
      name: 'Hunter’s Mark', type: 'spell', kind: 'ability', class: 'hunter', tree: null, icon: 'ability_hunter_snipershot', source: 'client',
    });
  });

  test('rule 1: talent/ability of the requested class beats everything', async () => {
    const idx = await index();
    // "Whirlwind": warrior ability vs NPC spell; "Frostbolt": mage ability vs NPC spell
    assert.equal(idx.lookup('Frostbolt', { classSlug: 'mage' }).kind, 'ability');
    assert.equal(idx.lookup('Frostbolt', { classSlug: 'mage' }).class, 'mage');
  });

  test('rule 2: talent/ability of another class beats a plain spell', async () => {
    const idx = await index();
    const r = idx.lookup('Frostbolt', { classSlug: 'warrior' }); // no warrior Frostbolt
    assert.deepEqual([r.kind, r.class], ['ability', 'mage']);
    assert.equal(idx.lookup('Whirlwind').kind, 'ability');
  });

  test('rule 3: plain spell when no class entry exists; the class hint is only a preference', async () => {
    const idx = await index();
    const r = idx.lookup('Dodge', { classSlug: 'rogue' });
    assert.deepEqual([r.kind, r.class, r.icon], ['spell', null, 'spell_nature_invisibilty']);
  });

  test('talent results carry tree', async () => {
    const idx = await index();
    assert.deepEqual([idx.lookup('Bestial Wrath').kind, idx.lookup('Bestial Wrath').tree], ['talent', 'beast-mastery']);
  });

  test('items: fallback when there is no spell, first choice with preferType item', async () => {
    const idx = await index();
    assert.deepEqual(idx.lookup('Taran Icebreaker'), { name: 'Taran Icebreaker', type: 'item', kind: 'item', class: null, tree: null, icon: 'inv_sword_04', source: 'client' });
    assert.equal(idx.lookup('Windfury Totem').type, 'spell'); // a spell of that name exists
    assert.equal(idx.lookup('Windfury Totem', { preferType: 'item' }).type, 'item');
    assert.equal(idx.lookup('Mutilate', { preferType: 'item' }).type, 'spell'); // no such item: falls back
  });

  test('misses, junk input and prototype names return null and never throw', async () => {
    const idx = await index();
    for (const n of ['Nonexistent Spell', '', '   ', undefined, null, 42, 'constructor', '__proto__', 'toString']) {
      assert.equal(idx.lookup(n), null, String(n));
    }
    assert.equal(makeGameIndex(null).lookup('x'), null);
    assert.equal(makeGameIndex({ spells: { x: 'not an array' } }).lookup('x'), null);
  });

  test('entries without an icon are never returned', () => {
    const idx = makeGameIndex({ spells: { foo: [{ name: 'Foo', kind: 'spell', class: null, tree: null, icon: '', id: 1 }] }, items: { foo: [{ name: 'Foo', icon: null, id: 2 }] } });
    assert.equal(idx.lookup('foo'), null);
  });

  test('verified and source on entries are passed through', () => {
    const idx = makeGameIndex({ spells: { foo: [{ name: 'Foo', kind: 'talent', class: 'mage', tree: 'fire', icon: 'a', id: 1, verified: false, source: 'wowhead' }] } });
    const r = idx.lookup('foo');
    assert.equal(r.verified, false);
    assert.equal(r.source, 'wowhead');
  });
});

describe('parseWowheadTalentData', () => {
  const text = fixture('wowhead-talents.txt');

  test('finds the talentCalcClassic call among several, survives braces and escaped quotes in strings', () => {
    const t = parseWowheadTalentData(text);
    assert.equal(t.length, 6);
    assert.deepEqual(t.find((x) => x.name === 'Incineration'), {
      id: 105796, name: 'Incineration', icon: 'spell_fire_flameshock', tabId: 41, row: 0, col: 1, ranks: [18459, 18459],
    });
    assert.equal(t.find((x) => x.name === 'Mortal Strike').icon, 'ability_warrior_savageblow'); // lower-cased
    assert.equal(t.find((x) => x.name === 'Mortal Strike').tabId, 161);
  });

  test('malformed input gives []', () => {
    for (const bad of ['', null, undefined, 'garbage', 'WH.setPageData("wow.talentCalcClassic.x",{"talents":{', 'WH.setPageData("wow.talentCalcClassic.x",{"talents":}})',
      'WH.setPageData("wow.talentCalcClassic.x",{"talents":{"1":{"2":{"id":2}}}});', 'WH.setPageData("wow.other",{"talents":{}});', '<html>']) {
      assert.deepEqual(parseWowheadTalentData(bad), [], String(bad));
    }
  });
});

describe('fetchWowheadTalents', () => {
  test('one request with the honest User-Agent; failures log and return []', async () => {
    const calls = [];
    const ok = async (url, init) => { calls.push({ url, init }); return new Response(fixture('wowhead-talents.txt')); };
    assert.equal((await fetchWowheadTalents({ fetchImpl: ok, log: () => {} })).length, 6);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://nether.wowhead.com/forever/data/talents-classic');
    assert.match(calls[0].init.headers['User-Agent'], /^wow-4ever-changes\/0\.1/);

    const logs = [];
    assert.deepEqual(await fetchWowheadTalents({ fetchImpl: async () => new Response('x', { status: 500 }), log: (m) => logs.push(m) }), []);
    assert.deepEqual(await fetchWowheadTalents({ fetchImpl: async () => { throw new Error('boom'); }, log: (m) => logs.push(m) }), []);
    assert.deepEqual(await fetchWowheadTalents({ fetchImpl: async () => new Response('nothing here'), log: (m) => logs.push(m) }), []);
    assert.equal(logs.length, 3);
  });
});

describe('mergeWowheadTalents', () => {
  /** Fixture client data and the fixture Wowhead talents. */
  async function setup() {
    const data = await buildGameIndexData({ fetchImpl: makeFetch(), version: '1', pauseMs: 0 });
    return { data, wh: parseWowheadTalentData(fixture('wowhead-talents.txt')) };
  }

  test('equal icons (case-insensitive) -> verified true; differing -> false, client icon kept', async () => {
    const { data, wh } = await setup();
    const logs = [];
    const merged = mergeWowheadTalents(data, wh, { log: (m) => logs.push(m) });
    const idx = makeGameIndex(merged);
    assert.equal(idx.lookup('Improved Fireball').verified, true);
    assert.equal(idx.lookup('Mortal Strike').verified, true);
    const fc = idx.lookup('Feral Charge');
    assert.equal(fc.verified, false);
    assert.equal(fc.icon, 'ability_hunter_pet_bear'); // client icon kept
    assert.equal(fc.source, 'client');
    assert.ok(logs.some((l) => /1 of 4 talent icons differ.*Feral Charge/.test(l)), logs.join('|'));
    assert.equal(idx.lookup('Bestial Wrath').verified, undefined); // not in the Wowhead file: not cross-checked
  });

  test('fallback match by a shared rank spell id when the names differ', async () => {
    const { data, wh } = await setup();
    const idx = makeGameIndex(mergeWowheadTalents(data, wh));
    assert.equal(idx.lookup('Mutilate').verified, true); // Wowhead calls it "Mutilation", rank 820 is shared
    assert.equal(idx.lookup('Mutilation'), null); // matched, so it is not added under its Wowhead name too
  });

  test('talents only Wowhead has are added with class/tree from the client tab (or null)', async () => {
    const { data, wh } = await setup();
    const idx = makeGameIndex(mergeWowheadTalents(data, wh));
    assert.deepEqual(idx.lookup('Incineration'), {
      name: 'Incineration', type: 'spell', kind: 'talent', class: 'mage', tree: 'fire', icon: 'spell_fire_flameshock', source: 'wowhead',
    });
    const mystery = idx.lookup('Mystery Talent');
    assert.deepEqual([mystery.class, mystery.tree, mystery.source], [null, null, 'wowhead']);
  });

  test('does not modify its input', async () => {
    const { data, wh } = await setup();
    const before = JSON.stringify(data);
    mergeWowheadTalents(data, wh);
    assert.equal(JSON.stringify(data), before);
  });
});
