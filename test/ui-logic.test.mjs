/**
 * ui-logic.test.mjs - unit tests for assets/logic.js (run with `node --test`).
 * Sections mirror logic.js: dates, grouping, filtering, search, suggestions, hash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../assets/logic.js';

/** The shared sample data (docs/SCHEMA.md format). */
const data = JSON.parse(readFileSync(new URL('../data/changes.json', import.meta.url), 'utf8'));

/** Small helper to build a change object with sensible defaults. */
const mk = (o) => ({ id: 'x', scope: 'class', category: 'Classes', class: null, spec: null, group: null, text: '', notes: [], subjects: [], ...o });

/* ---------- dates ---------- */
test('relativeDay gives friendly hints', () => {
  const now = new Date('2026-11-15T10:00:00Z');
  assert.equal(L.relativeDay('2026-11-15', now), 'today');
  assert.equal(L.relativeDay('2026-11-14', now), 'yesterday');
  assert.equal(L.relativeDay('2026-11-13', now), '2 days ago');
  assert.equal(L.relativeDay('2026-10-25', now), '3 weeks ago');
  assert.equal(L.relativeDay('garbage', now), '');
});

/* ---------- grouping ---------- */
test('groupChanges: all-classes first, specs nested, general by category/group', () => {
  const day = data.days[0];
  const g = L.groupChanges(day.changes);
  assert.equal(g.count, 5);
  assert.deepEqual(g.classSections.map((s) => s.label), ['All classes', 'Druid', 'Paladin']);
  assert.equal(g.classSections[1].specs[0].label, 'Restoration');
  assert.equal(g.classSections[2].direct.length, 1);
  assert.deepEqual(g.general.map((c) => c.category), ['Dungeons', 'Items']);
  assert.equal(g.general[0].groups[0].group, 'The Deadmines');
});

test('groupChanges puts ungrouped general lines before grouped ones', () => {
  const g = L.groupChanges([
    mk({ scope: 'general', category: 'Dungeons', group: 'A', text: 'a' }),
    mk({ scope: 'general', category: 'Dungeons', group: null, text: 'b' }),
  ]);
  assert.deepEqual(g.general[0].groups.map((x) => x.group), [null, 'A']);
});

/* ---------- filtering: class ---------- */
test('class filter keeps that class plus "All classes" lines', () => {
  const st = { ...L.defaultState(), cls: 'paladin' };
  const v = L.visibleDays(data, st);
  const ids = v.flatMap((d) => d.changes.map((c) => c.id));
  assert.ok(ids.includes('2026-11-13-000')); // all classes
  assert.ok(ids.includes('2026-11-13-002')); // paladin
  assert.ok(ids.includes('2026-11-11-001')); // paladin retribution (every spec)
  assert.ok(!ids.includes('2026-11-13-001')); // druid
});

/* ---------- filtering: spec ---------- */
test('spec filter keeps spec lines, class-wide lines and All-classes lines', () => {
  const st = { ...L.defaultState(), cls: 'paladin', spec: 'retribution' };
  const ids = L.visibleDays(data, st).flatMap((d) => d.changes.map((c) => c.id));
  assert.ok(ids.includes('2026-11-11-001')); // retribution
  assert.ok(ids.includes('2026-11-11-000')); // paladin, spec null
  assert.ok(ids.includes('2026-11-13-000')); // all classes
  const holy = L.visibleDays(data, { ...st, spec: 'holy' }).flatMap((d) => d.changes.map((c) => c.id));
  assert.ok(!holy.includes('2026-11-11-001')); // retribution hidden for holy
  assert.ok(holy.includes('2026-11-11-000'));
});

test('specsForClass merges vanilla trees with trees seen in data', () => {
  assert.deepEqual(L.specsForClass(data, 'paladin'), ['holy', 'protection', 'retribution']);
  const extra = { days: [{ changes: [mk({ class: 'mage', spec: 'chronomancy' })] }] };
  assert.deepEqual(L.specsForClass(extra, 'mage'), ['arcane', 'fire', 'frost', 'chronomancy']);
  assert.deepEqual(L.specsForClass(data, ''), []);
});

/* ---------- filtering: General toggle ---------- */
test('General toggle hides every general change but keeps class lines', () => {
  const off = L.visibleDays(data, { ...L.defaultState(), general: false });
  const all = off.flatMap((d) => d.changes);
  assert.ok(all.length > 0);
  assert.ok(all.every((c) => c.scope === 'class'));
  // General lines are not affected by the class filter.
  const on = L.visibleDays(data, { ...L.defaultState(), cls: 'druid' }).flatMap((d) => d.changes);
  assert.ok(on.some((c) => c.scope === 'general'));
});

/* ---------- icons ---------- */
test('iconUrl builds the Wowhead URL and rejects odd names', () => {
  assert.equal(L.iconUrl('inv_mace_13'), 'https://wow.zamimg.com/images/wow/icons/medium/inv_mace_13.jpg');
  assert.equal(L.iconUrl('../evil'), null);
  assert.equal(L.iconUrl(undefined), null);
});

test('glyphKey picks neutral glyphs per general category', () => {
  assert.equal(L.glyphKey(mk({})), 'spark');
  assert.equal(L.glyphKey(mk({ scope: 'general', category: 'Items' })), 'gem');
  assert.equal(L.glyphKey(mk({ scope: 'general', category: 'Quests' })), 'scroll');
  assert.equal(L.glyphKey(mk({ scope: 'general', category: 'Dungeons' })), 'arch');
  assert.equal(L.glyphKey(mk({ scope: 'general', category: 'Zones' })), 'hex');
});

/* ---------- search ---------- */
test('matchesQuery: all words, case-insensitive, over text/notes/subjects/group/category', () => {
  const ch = data.days[0].changes[2]; // Judgement of Command + dev note
  assert.ok(L.matchesQuery(ch, 'JUDGEMENT melee'));
  assert.ok(L.matchesQuery(ch, 'stay ranged')); // in the note
  assert.ok(!L.matchesQuery(ch, 'judgement fireball'));
  assert.ok(L.matchesQuery(ch, '')); // empty matches all
  const deadmines = data.days[0].changes[3];
  assert.ok(L.matchesQuery(deadmines, 'deadmines')); // group
  assert.ok(L.matchesQuery(deadmines, 'dungeons sneed')); // category + text
  const item = data.days[0].changes[4];
  assert.ok(L.matchesQuery(item, 'taran')); // subject name / text
});

test('search combines with class filter via visibleDays', () => {
  const v = L.visibleDays(data, { ...L.defaultState(), cls: 'paladin', q: 'windfury' });
  assert.deepEqual(v.flatMap((d) => d.changes.map((c) => c.id)), ['2026-11-11-001']);
});

test('highlightSegments marks matches and escapes regex characters', () => {
  const segs = L.highlightSegments('Judgement of Command', ['judge', 'cmd', 'command']);
  assert.deepEqual(segs.filter((s) => s.match).map((s) => s.text), ['Judge', 'Command']);
  assert.equal(segs.map((s) => s.text).join(''), 'Judgement of Command');
  assert.deepEqual(L.highlightSegments('a (b)', ['(b']), [{ text: 'a ', match: false }, { text: '(b', match: true }, { text: ')', match: false }]);
  assert.deepEqual(L.highlightSegments('abc', []), [{ text: 'abc', match: false }]);
});

/* ---------- suggestions ---------- */
test('empty query suggests skill names, most frequently changed first', () => {
  const extra = { days: [{ changes: [
    mk({ subjects: [{ name: 'Zeal', type: 'spell', icon: 'z' }] }),
    mk({ subjects: [{ name: 'Zeal', type: 'spell', icon: 'z' }, { name: 'Thing', type: 'item', icon: 't' }] }),
    mk({ subjects: [{ name: 'Alpha', type: 'spell', icon: 'a' }] }),
  ] }] };
  const s = L.buildSuggestions(extra, L.defaultState(), '');
  assert.deepEqual(s.map((x) => [x.name, x.count]), [['Zeal', 2], ['Alpha', 1]]); // items excluded
});

test('suggestions respect the class/spec filter', () => {
  const names = (st) => L.buildSuggestions(data, st, '').map((s) => s.name);
  assert.ok(names(L.defaultState()).includes('Wild Growth'));
  assert.ok(!names({ ...L.defaultState(), cls: 'paladin' }).includes('Wild Growth'));
  assert.ok(!names({ ...L.defaultState(), cls: 'paladin', spec: 'holy' }).includes('Unsealed Fury'));
  assert.ok(names({ ...L.defaultState(), cls: 'paladin', spec: 'retribution' }).includes('Unsealed Fury'));
});

test('typing narrows: prefix matches first, then substring; items allowed', () => {
  const s = L.buildSuggestions(data, L.defaultState(), 'ju').map((x) => x.name);
  assert.deepEqual(s.slice(0, 2).sort(), ['Judgement', 'Judgement of Command']);
  const sub = L.buildSuggestions(data, L.defaultState(), 'command').map((x) => x.name);
  assert.deepEqual(sub, ['Judgement of Command']); // substring match
  assert.equal(L.buildSuggestions(data, L.defaultState(), 'icebreaker')[0].type, 'item');
});
