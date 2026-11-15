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
