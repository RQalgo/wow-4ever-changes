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
import { parse as parseDom } from 'node-html-parser';
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

describe('list walker', () => {
  test('non-class headings under Classes become a group of all-class changes', () => {
    // Seen in the real post: "Cooldown Manager" as a bold heading under Classes.
    const html = day('Classes', `<ul>
      <li><strong>Cooldown Manager</strong><ul><li>Now shows Seals.</li></ul></li>
      <li><strong>Paladin</strong><ul>
        <li><strong>Retribution</strong><ul>
          <li><strong>Seals</strong><ul><li>Seal text.</li></ul></li>
        </ul></li>
      </ul></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map(brief), [
      { scope: 'class', category: 'Classes', class: null, spec: null, group: 'Cooldown Manager', text: 'Now shows Seals.', notes: [] },
      { scope: 'class', category: 'Classes', class: 'paladin', spec: 'retribution', group: 'Seals', text: 'Seal text.', notes: [] },
    ]);
  });

  test('nested bold headings in general categories join into "A > B"', () => {
    const html = day('Dungeons', `<ul>
      <li><strong>Blackrock Depths</strong><ul>
        <li><strong>Lyceum</strong><ul><li>Fewer adds.</li></ul></li>
        <li>Door fixed.</li>
      </ul></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.scope, c.class, c.group, c.text]), [
      ['general', null, 'Blackrock Depths > Lyceum', 'Fewer adds.'],
      ['general', null, 'Blackrock Depths', 'Door fixed.'],
    ]);
  });

  test('a bold-only item without a nested list is a change', () => {
    const html = day('Items', '<ul><li><strong>Thunderfury is back.</strong></li></ul>');
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.text, c.group]), [['Thunderfury is back.', null]]);
  });

  test('an item with its own text and a nested list is one change with notes', () => {
    const html = day('Quests', `<ul><li>Quest X reworked:
      <ul><li>Step one.</li><li>Step <em>two</em>.<ul><li>Sub-step.</li></ul></li></ul></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.text, c.notes]), [
      ['Quest X reworked:', ['Step one.', 'Step two.', 'Sub-step.']],
    ]);
  });

  test('event-name categories are general; Classes match is case-insensitive', () => {
    const html = day('Stranglethorn Fishing Extravaganza', '<ul><li>Prizes added.</li></ul>')
      + '<p><strong>CLASSES</strong></p><ul><li><strong>Rogue</strong><ul><li>Stealth.</li></ul></li></ul>';
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.scope, c.category, c.class]), [
      ['general', 'Stranglethorn Fishing Extravaganza', null],
      ['class', 'CLASSES', 'rogue'],
    ]);
  });

  test('text: entities decoded, whitespace collapsed, inline markup flattened, curly quotes kept', () => {
    const html = day('Items', '<ul><li>  Fixed&nbsp;the   “<strong>Hand</strong> of <em>Ragnaros</em>”\n &amp; Sulfuras&#8217; tooltip.<br>Again. </li></ul>');
    assert.equal(changes(parseHotfixHtml(html))[0].text, 'Fixed the “Hand of Ragnaros” & Sulfuras’ tooltip. Again.');
  });

  test('ordered lists, empty items and wrapper items are handled', () => {
    const html = day('User Interface', '<ol><li>One.</li><li> </li><li><ul><li>Two.</li></ul></li></ol>');
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => c.text), ['One.', 'Two.']);
  });

  test('a list after a date but before any category gets category "General"', () => {
    const html = '<p><strong>November 13, 2026</strong></p><ul><li>Orphan.</li></ul>';
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.scope, c.category]), [['general', 'General']]);
  });
});

describe('days and headings', () => {
  test('days are sorted newest first regardless of published order', () => {
    const html = day('Items', '<ul><li>a</li></ul>', 'November 2, 2026')
      + day('Items', '<ul><li>b</li></ul>', 'December 1, 2026')
      + day('Items', '<ul><li>c</li></ul>', 'November 20, 2026');
    assert.deepEqual(parseHotfixHtml(html).days.map((d) => d.date), ['2026-12-01', '2026-11-20', '2026-11-02']);
  });

  test('a repeated date merges into one day with continuous ids', () => {
    const html = day('Items', '<ul><li>a</li></ul>') + day('Quests', '<ul><li>b</li></ul>');
    const { days } = parseHotfixHtml(html);
    assert.equal(days.length, 1);
    assert.deepEqual(days[0].changes.map((c) => [c.id, c.category]), [['2026-11-13-001', 'Items'], ['2026-11-13-002', 'Quests']]);
  });

  test('<h3>, <h4> and <p><b> headings are accepted, anywhere in the document', () => {
    const html = `<div class="x"><section><h3>November 13, 2026</h3></section>
      <div><h4>Professions</h4><ul><li>Recipe fixed.</li></ul>
      <p><b>Enemies and NPCs</b></p><ul><li>Hogger hits harder.</li></ul></div></div>`;
    const { days } = parseHotfixHtml(html);
    assert.deepEqual(days.map((d) => d.label), ['November 13, 2026']);
    assert.deepEqual(days[0].changes.map((c) => [c.category, c.text]), [
      ['Professions', 'Recipe fixed.'],
      ['Enemies and NPCs', 'Hogger hits harder.'],
    ]);
  });

  test('a paragraph mixing bold and plain text is not a heading', () => {
    const html = '<p><strong>November 13, 2026</strong></p><p><strong>Note:</strong> servers restart.</p>'
      + '<p><strong>Items</strong></p><ul><li>a</li></ul>';
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => c.category), ['Items']);
  });

  test('lists and headings before the first date are ignored; empty input gives no days', () => {
    assert.deepEqual(parseHotfixHtml('<p><strong>Classes</strong></p><ul><li>x</li></ul>'), { days: [] });
    assert.deepEqual(parseHotfixHtml(''), { days: [] });
    assert.deepEqual(parseHotfixHtml(undefined), { days: [] });
  });
});

describe('developer notes', () => {
  test('marker variants: curly/straight apostrophe, singular, any case', () => {
    const variants = [
      'Developers’ notes: a', "Developers' notes: b", "Developer's note: c",
      'Developer’s note: d', 'DEVELOPERS’ NOTES: e', 'developers notes: f',
    ];
    const items = variants.map((v) => `<li><em>${v}</em></li>`).join('');
    const [change, ...rest] = changes(parseHotfixHtml(day('Items', `<ul><li>Change.</li>${items}</ul>`)));
    assert.equal(rest.length, 0);
    assert.deepEqual(change.notes, variants);
  });

  test('isDeveloperNote needs the whole item to be italic and start with the marker', () => {
    // Build the <li> children with the same DOM library the parser uses.
    const own = (html) => parseDom(`<li>${html}</li>`).firstChild.childNodes;
    assert.equal(isDeveloperNote(own('<em>Developers’ notes: yes</em>')), true);
    assert.equal(isDeveloperNote(own(' <i>Developers’ notes: also yes</i> ')), true);
    assert.equal(isDeveloperNote(own('<em><strong>Developer’s note:</strong> nested bold</em>')), true);
    assert.equal(isDeveloperNote(own('Developers’ notes: not italic')), false);
    assert.equal(isDeveloperNote(own('<em>Developers’ notes:</em> partly italic')), false);
    assert.equal(isDeveloperNote(own('<em>An italic change that is not a note.</em>')), false);
  });

  test('a non-note italic item stays a change', () => {
    const html = day('Items', '<ul><li>Base.</li><li><em>An italic change.</em></li></ul>');
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => c.text), ['Base.', 'An italic change.']);
  });

  test('a note with no previous change in its list is kept as a change', () => {
    const html = day('Classes', `<ul><li><strong>Mage</strong><ul>
      <li><em>Developers’ notes: leading note.</em></li><li>Blink fixed.</li></ul></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.class, c.text, c.notes]), [
      ['mage', 'Developers’ notes: leading note.', []],
      ['mage', 'Blink fixed.', []],
    ]);
  });

  test('a note after a heading block does not jump back to an earlier change', () => {
    const html = day('Classes', `<ul>
      <li>All classes change.</li>
      <li><strong>Hunter</strong><ul><li>Aimed Shot.</li></ul></li>
      <li><em>Developers’ notes: orphaned.</em></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.class, c.text, c.notes]), [
      [null, 'All classes change.', []],
      ['hunter', 'Aimed Shot.', []],
      [null, 'Developers’ notes: orphaned.', []],
    ]);
  });

  test('a note nested under a change becomes that change\'s note', () => {
    const html = day('Items', `<ul><li>Change.<ul><li><em>Developer’s note: why.</em></li></ul></li>
      <li><em>Developers’ notes: and more.</em></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => c.notes), [['Developer’s note: why.', 'Developers’ notes: and more.']]);
  });
});

describe('<script> fallback', () => {
  const FRAGMENT = '<hr><p><strong>November 13, 2026</strong></p><p><strong>Classes</strong></p>'
    + '<ul><li><strong>Warlock</strong><ul><li>Fear “fixed”.</li>'
    + '<li><em>Developers’ notes: because.</em></li></ul></li></ul>';
  const EXPECTED = [{
    scope: 'class', category: 'Classes', class: 'warlock', spec: null, group: null,
    text: 'Fear “fixed”.', notes: ['Developers’ notes: because.'],
  }];

  test('reads the article from a __NEXT_DATA__ JSON blob with \\u003c escapes', () => {
    const json = JSON.stringify({ props: { pageProps: { article: { title: 'x', body: FRAGMENT } } } })
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    const html = `<html><body><div id="__next"></div>
      <script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`;
    const { days } = parseHotfixHtml(html);
    assert.deepEqual(days.map((d) => [d.date, d.label]), [['2026-11-13', 'November 13, 2026']]);
    assert.deepEqual(days[0].changes.map(brief), EXPECTED);
    assert.equal(days[0].changes[0].id, '2026-11-13-001');
  });

  test('reads the article from a string literal in a JS assignment', () => {
    const html = `<script>window.__STATE__ = { id: 1, content: ${JSON.stringify(FRAGMENT)}, ok: !0 };</script>`;
    assert.deepEqual(changes(parseHotfixHtml(html)).map(brief), EXPECTED);
  });

  test('reads double-encoded JSON inside a JSON string value', () => {
    const inner = JSON.stringify({ html: FRAGMENT });
    const html = `<script type="application/json">${JSON.stringify({ payload: inner })}</script>`;
    assert.deepEqual(changes(parseHotfixHtml(html)).map(brief), EXPECTED);
  });

  test('prefers the candidate with the most dates', () => {
    const teaser = '<p><strong>Latest:</strong> November 13, 2026</p>';
    const two = FRAGMENT + '<p><strong>November 11, 2026</strong></p><p><strong>Items</strong></p><ul><li>a</li></ul>';
    const html = `<script>var a = ${JSON.stringify(teaser)}; var b = ${JSON.stringify(two)};</script>`;
    const found = findArticleHtmlInScripts(html);
    assert.equal(found[0], two);
    assert.deepEqual(parseHotfixHtml(html).days.map((d) => d.date), ['2026-11-13', '2026-11-11']);
  });

  test('DOM content wins over script data when date headings exist', () => {
    const html = day('Items', '<ul><li>From DOM.</li></ul>')
      + `<script>var s = ${JSON.stringify(FRAGMENT)};</script>`;
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => c.text), ['From DOM.']);
  });

  test('no dates anywhere gives { days: [] }', () => {
    const html = '<p>Nothing here</p><script>var x = "<strong>bold</strong> but no date";</script>'
      + '<script type="application/json">{"a":"November 13, 2026 without markup"}</script>';
    assert.deepEqual(findArticleHtmlInScripts(html), []);
    assert.deepEqual(parseHotfixHtml(html), { days: [] });
  });
});

// --- Review additions -------------------------------------------------------

test('lists outside the article body (nav, related links, footer) are ignored', () => {
  const html =
    '<body><nav><ul><li>Games</li></ul></nav><main><article><div><hr>' +
    '<p><strong>November 9, 2026</strong></p><p><strong>Items</strong></p>' +
    '<ul><li>Foo fixed.</li></ul></div>' +
    '<div class="related"><ul><li>Related article</li></ul></div></article></main>' +
    '<footer><ul><li>Careers</li><li>Privacy</li></ul></footer></body>';
  const { days } = parseHotfixHtml(html);
  assert.deepEqual(days[0].changes.map((c) => c.text), ['Foo fixed.']);
});

test('days in separate wrappers are all found via their common ancestor', () => {
  const day = (d) => `<section><p><strong>${d}</strong></p><p><strong>Items</strong></p><ul><li>X ${d}</li></ul></section>`;
  const html = `<article>${day('November 9, 2026')}${day('November 6, 2026')}</article><footer><ul><li>Careers</li></ul></footer>`;
  const { days } = parseHotfixHtml(html);
  assert.equal(days.length, 2);
  assert.equal(days.flatMap((d) => d.changes).length, 2);
});

test('list items whose content is wrapped in <p> still yield class headings', () => {
  const html =
    '<div><p><b>November 9, 2026</b></p><p><strong>Classes</strong></p>' +
    '<ul><li><p><strong>Paladin</strong></p><ul><li><p>Fixed Consecration.</p></li>' +
    "<li><p><em>Developers' note: x</em></p></li></ul></li></ul></div>";
  const [c, ...rest] = parseHotfixHtml(html).days[0].changes;
  assert.equal(rest.length, 0);
  assert.equal(c.class, 'paladin');
  assert.equal(c.text, 'Fixed Consecration.');
  assert.deepEqual(c.notes, ["Developers' note: x"]);
});

// --- Patch-notes support (schema v2) ---------------------------------------

describe('Change Log headings', () => {
  test('isChangeLogHeading accepts case and spacing variants only', async () => {
    const { isChangeLogHeading } = await import('../scripts/parse.mjs');
    for (const t of ['Change Log', 'CHANGE LOG', 'changelog', ' Change  Log: ']) assert.equal(isChangeLogHeading(t), true, t);
    for (const t of ['Change Logs of Doom', 'Classes', 'Log']) assert.equal(isChangeLogHeading(t), false, t);
  });

  test('a "Change Log" heading in the hotfix post is not a category', () => {
    const html = '<p><strong>November 13, 2026</strong></p><p><strong>Change Log</strong></p><ul><li>a</li></ul>';
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => c.category), ['General']);
  });
});

describe('talent-tree rule', () => {
  test('talentTreeSlug knows each class\'s trees and maps Feral Combat to feral', async () => {
    const { talentTreeSlug } = await import('../scripts/parse.mjs');
    assert.equal(talentTreeSlug('druid', 'Feral Combat'), 'feral');
    assert.equal(talentTreeSlug('druid', 'Feral'), 'feral');
    assert.equal(talentTreeSlug('hunter', 'Beast Mastery'), 'beast-mastery');
    assert.equal(talentTreeSlug('paladin', 'Holy'), 'holy');
    assert.equal(talentTreeSlug('warrior', 'Holy'), null, 'not a warrior tree');
    assert.equal(talentTreeSlug('hunter', 'Pets'), null);
    assert.equal(talentTreeSlug(null, 'Fire'), null);
  });

  test('under a class, a real tree is a spec; anything else is a group', () => {
    const html = day('Classes', `<ul>
      <li><strong>Hunter</strong><ul>
        <li><strong>Pets</strong><ul><li>Pet line.</li></ul></li>
        <li><strong>Marksmanship</strong><ul><li>Aimed line.</li></ul></li>
      </ul></li>
      <li><strong>Druid</strong><ul>
        <li><strong>Feral Combat</strong><ul><li>Cat line.</li></ul></li>
        <li><strong>Gnome</strong><ul><li>Odd line.</li></ul></li>
      </ul></li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.class, c.spec, c.group, c.text]), [
      ['hunter', null, 'Pets', 'Pet line.'],
      ['hunter', 'marksmanship', null, 'Aimed line.'],
      ['druid', 'feral', null, 'Cat line.'],
      ['druid', null, 'Gnome', 'Odd line.'],
    ]);
  });
});

describe('loose headings (bold-only items without a nested list)', () => {
  test('a bold-only item followed by plain siblings heads those siblings', () => {
    const html = day('Races', `<ul>
      <li><strong>Tauren</strong></li><li>Cultivation now has a cast time.</li><li>Plainsrunning fixed.</li>
      <li><strong>Orc</strong></li><li>Blood Fury changed.</li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.group, c.text]), [
      ['Tauren', 'Cultivation now has a cast time.'],
      ['Tauren', 'Plainsrunning fixed.'],
      ['Orc', 'Blood Fury changed.'],
    ]);
  });

  test('a heading-only item followed by a text-less wrapper item owns its nested list', () => {
    const html = day('Zones', '<ul><li><strong>Elwynn</strong></li><li><ul><li>Kobolds.</li></ul></li></ul>');
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.group, c.text]), [['Elwynn', 'Kobolds.']]);
  });

  test('under Classes a loose class heading sets the class', () => {
    const html = day('Classes', '<ul><li><strong>Mage</strong></li><li>Blink fixed.</li></ul>');
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.class, c.text]), [['mage', 'Blink fixed.']]);
  });

  test('a loose heading ends at the next heading item with a nested list', () => {
    const html = day('Items', `<ul><li><strong>A</strong></li><li>a1</li>
      <li><strong>B</strong><ul><li>b1</li></ul></li><li>plain</li></ul>`);
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.group, c.text]), [
      ['A', 'a1'], ['B', 'b1'], [null, 'plain'],
    ]);
  });

  test('bold-only items followed only by bold-only items stay changes (hotfix behaviour)', () => {
    const html = day('Items', '<ul><li>Base.</li><li><strong>First bold.</strong></li><li><strong>Second bold.</strong></li></ul>');
    assert.deepEqual(changes(parseHotfixHtml(html)).map((c) => [c.group, c.text]), [
      [null, 'Base.'], [null, 'First bold.'], [null, 'Second bold.'],
    ]);
  });
});

test('hotfix days carry kind "hotfix" and null title/sourceUrl', () => {
  const { days } = parseHotfixHtml(FIXTURE);
  for (const d of days) {
    assert.deepEqual(Object.keys(d), ['date', 'kind', 'title', 'sourceUrl', 'label', 'changes']);
    assert.equal(d.kind, 'hotfix');
    assert.equal(d.title, null);
    assert.equal(d.sourceUrl, null);
  }
});
