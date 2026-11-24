# Plan

## Goal
Show WoW: Forever changes at a glance: grouped by date, filterable by
class > talent tree, searchable by skill name, with a skill icon per line and
a General section for non-class changes. Public, non-commercial.

## Source
Blizzard keeps one rolling post, "WoW: Forever Hotfixes"
(https://news.blizzard.com/en-us/article/24315281). Its body is:

    <hr>
    <p><strong>November 13, 2026</strong></p>     <- date
    <p><strong>Classes</strong></p>               <- category
    <ul>
      <li>General class change (no class)</li>
      <li><strong>Paladin</strong>                <- class
        <ul>
          <li>Change text</li>
          <li><em>Developers' notes: ...</em></li> <- note for the line above
          <li><strong>Retribution</strong>         <- talent tree
            <ul><li>Change text</li></ul></li>
        </ul></li>
    </ul>
    <p><strong>Items</strong></p><ul>...</ul>      <- non-class category

## Pipeline (runs daily in GitHub Actions)
1. `scripts/fetch.mjs`   download the post HTML
2. `scripts/parse.mjs`   HTML -> structured days/changes (docs/SCHEMA.md)
3. `scripts/icons.mjs`   find skill/item names in each line, look up icons
                          on Wowhead (cached in data/icon-cache.json)
4. write `data/changes.json` and commit it to `main` if it changed; GitHub
   Pages (deploy from branch: `main`, root) republishes automatically

## Web app (`index.html` + `assets/`)
Plain HTML/CSS/JS, no build step. Date groups, class > spec filter,
General section, search box that suggests skill names by default, deep-linkable
filter state in the URL hash, light/dark.

## Task list
| # | Task | Owner |
|---|---|---|
| 1 | Scaffold, plan, schema, sample data | lead |
| 2 | Parser + fetcher + tests | Opus agent, PR |
| 3 | Web app UI incl. search with skill suggestions | Sonnet agent, PR |
| 4 | Icon resolver + cache + tests | Sonnet agent, PR |
| 5 | Workflows: scheduled update, CI; pipeline orchestrator | Sonnet agent, PR |
| 6 | Review + merge each PR, end-to-end check | lead |

## Conventions
- Small commits, one logical change each.
- Every file starts with a header comment explaining its purpose; non-obvious
  logic is commented inline.
- Node 22, ES modules, `node --test`. Keep dependencies minimal.

## Update: patch notes (second source)
- `data/sources.json` lists the sources; `scripts/sources.mjs` turns each one
  into days. `news-rolling` = the hotfix post; `discourse-topic` = a Blizzard
  forum topic fetched as JSON, one patch day per staff post (empty posts and
  "we updated the previous post" notices are skipped; dates are US Pacific).
- `scripts/parse.mjs` gained `parsePatchPost` for the forum markup (categories
  as bold list items or bold paragraphs, "Change Log" headings ignored).
- Days carry `kind`, `title`, `sourceUrl` (docs/SCHEMA.md, version 2); days
  are keyed by date + kind.
- The UI shows a Hotfix/Patch badge on every date and an
  All / Hotfixes / Patches filter.

## Update: tags and icon coverage
- Every change has `tags` (docs/SCHEMA.md, version 3), computed by the pure
  functions in `scripts/tags.mjs` (`computeTags`, `addTags`). `update.mjs` runs
  `addTags` over ALL merged days, stored ones included, so a rule change revises
  the whole history on the next run.
- Subjects are found in the text and then the notes (max 8), with `kind`
  (talent / ability / spell / item), `class`, `tree`, `source`
  (`override` | `client` | `wowhead`) and `verified`. Extraction understands
  patch-note style: `Name: description`, possessives, `New Talent ... in Row N`,
  `Removed`, and `A and B` lists (`extractCandidateGroups` keeps the whole phrase
  of one-word pairs such as "Slice and Dice" as a first try).
- Icon sources: overrides, then the optional game-data index (`gameIndex`, from
  `scripts/gamedata.mjs`; no network), then Wowhead. A client-resolved name that
  Wowhead also answered gets `verified` true / false (the client icon wins).
  Wowhead budget per run: 250 lookups, 1.5 s apart, spent on names unknown to
  the client index first, then at most 100 cross-checks, then refreshing old
  cache entries (v2 shape, no kind/class).
- `data/name-aliases.json` maps a name as written in the notes to the game-data
  name; the subject keeps the written name and gets `alias`.
- Known gaps: typos in the source are not fixed; names with a leading
  adjective that Wowhead lacks may still miss; the class-word detector is
  deliberately conservative ("Tauren Warriors" gets no class tag).

## Update: client data as icon source
- `scripts/gamedata.mjs` builds a name -> icon/kind/class/tree index from the
  game client's DB2 tables (via wago.tools CSV: SpellName, SpellMisc, Talent,
  TalentTab, SkillLine(Ability), ManifestInterfaceData, ItemSparse, Item) for the
  newest `wowf` build. The CSVs are streamed (own RFC-4180 parser, no new
  dependency) and only needed columns are kept; the small result is cached as
  `.cache/gamedata/index-<build>.json` (and kept between runs with
  `actions/cache`).
- Wowhead stays as fallback and cross-check. Its talent-calculator file is
  fetched at most once per 24 h; talents are matched to the client's by tab id +
  name (or a shared rank spell id) and marked `verified` true/false, and talents
  only Wowhead has are added (`source: "wowhead"`).
- Every failure (network, HTTP status, bad CSV, missing column) logs one line
  and degrades: cached index, then Wowhead-only talents, then null. Never throws.
- Real endpoints were not reachable from the development sandbox; the code is
  tested against fixture CSVs under `test/fixtures/gamedata/`.

## Update: dev posts
- Third source, `discourse-tracker` (docs/SCHEMA.md, version 4): the forum's
  Blizzard tracker feed, filtered to category 347 (WoW: Forever General
  Discussion). One `kind: "dev"` day per US Pacific date, one change per staff
  post: the topic title (or `Reply in “…”`), a summary of at most 400
  characters, link, author and post number.
- Paging with `before_post_id` until an empty page, a page older than the
  cutoff (oldest stored day, or 2026-09-01) or 30 pages; 500 ms between
  requests. Bodies (`/posts/<id>.json`) only for posts not stored yet; a
  failed body falls back to the feed excerpt. Stored posts are reused as
  stored, so ids and tags stay stable and posts that fall off the feed stay.
- Subjects and tags come from the whole post through the transient
  `_fullText` field, which `update.mjs` deletes before writing.
- New tag `media` (dev posts only) and conservative `systems` / `pvp` words.
- Data fixes in the same change: a sentence is never a heading in the
  parser (the "Gamepad Support › Gamepad Support has entered …" group);
  groups are joined with " › " like the UI, and stored days are normalised;
  NPC abilities outside Classes ("Deathless Guardian's Shield Slam") add no
  class or talent tags.
- The update workflow runs every 3 hours at :41 (the 6-hourly schedule never
  fired).
- Not verified against the live endpoints from the development sandbox (no
  access); the code is tested against fixtures with the feed's real shape.

## Missed posts fix (2026-11-24)

Posts seen on Reddit were missing from the site although every run succeeded.
Checked against the live sources in a browser:

- **Dev posts:** only category 347 (General Discussion) was read. Blizzard
  also posts staff announcements in 352 (WoW Forever Bug Report), e.g.
  "Lockbox exploit and economy hold heuristic" (Nov 23) and "Lost Training
  Purchase Refunds - November 13". The tracker source now reads
  `[347, 352]` and skips the Bug Report copy of the hotfix news post
  (`excludeTopicTitle: "^WoW: Forever Hotfixes"`).
- **Hotfixes:** the November 23 section was missing. Blizzard's forum copy of
  it was posted at 02:06 UTC, one minute before a run read the news page;
  the parser handles the section fine. GitHub had been starting only about 3
  of the 8 scheduled daily runs, so nothing re-read the page for 10+ hours.
  The workflow now runs hourly at :41.
- **Backfill:** the manual run has a *tracker_cutoff* input (TRACKER_CUTOFF)
  so older posts of a newly added category can be read once.
- Stored hotfix days Nov 5 – Nov 20 were compared with the live post: none
  is missing items.
