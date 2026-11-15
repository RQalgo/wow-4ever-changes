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
