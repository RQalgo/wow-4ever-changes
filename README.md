# WoW: Forever — Changes at a Glance

A small, mobile- and desktop-friendly web app that shows the hotfixes and
patch-note changes for **World of Warcraft: Forever**, grouped by date,
filterable by class and talent tree (for example *Paladin > Retribution*) and
searchable by skill name.

- Plan and task list: [`docs/PLAN.md`](docs/PLAN.md)
- Data format shared by every part of the project: [`docs/SCHEMA.md`](docs/SCHEMA.md)

## Layout

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The static web app (plain HTML/CSS/JS, no build step), served by GitHub Pages from the root of `main` |
| `scripts/` | Node scripts: fetch the official post, parse it, resolve icons |
| `data/` | Generated data (`changes.json`) and the icon lookup cache |
| `test/` | `node --test` unit tests and HTML fixtures |
| `.github/workflows/` | Scheduled data update, and CI |

## Using it

Live site: https://rqalgo.github.io/wow-4ever-changes/

- Pick a class, then a talent tree. A tree view also shows the class-wide and
  all-class lines, since those affect the tree too.
- Tap the search box to get skill-name suggestions; type to narrow.
- Each date shows a **Hotfix** or **Patch** badge (patch days also show the
  patch title and a Source link). Use the *All / Hotfixes / Patches* switch to
  show only one kind.
- The view is stored in the URL, e.g.
  `#class=paladin&spec=retribution` or `#kind=patch`, so it can be bookmarked
  or shared.

## How the data stays current

`.github/workflows/update-data.yml` runs every 6 hours (and on demand from the
Actions tab). It downloads Blizzard's rolling hotfix post, parses it, looks up
icons, and commits `data/changes.json` when something changed. GitHub Pages
(deploy from branch `main`, root) then republishes by itself. Days that
Blizzard later drops from the post are kept.

Sources are listed in `data/sources.json`. There are two today: the rolling
hotfix post (`kind: "hotfix"`) and Blizzard's forum topic of build notes
(`kind: "patch"`, one dated entry per Blizzard post). When Blizzard publishes a
new patch-notes topic, add an entry like the existing `discourse-topic` one
with its forum URL; it is not discovered automatically. If one source fails,
the other still updates and the failed source's stored days are kept.

Icon lookups are rate-limited on purpose (150 new names per run, 1.2 s apart)
and cached in `data/icon-cache.json`; names that are still unknown are retried
on later runs. Lines without an icon show a class or category tile.

## Maintenance

- **Wrong or missing icon:** edit `data/icon-overrides.json`. Keys are
  lower-case names; a value of `{ "name", "type", "icon" }` forces an icon,
  `null` stops a word from being treated as a skill.
- **A run failed:** open the run in the Actions tab; the "Run update" step
  prints the reason. If Blizzard changes the page layout the parser refuses to
  overwrite good data, so the site keeps showing the last good version.
- **Local development:** `npm ci`, `npm test`, `npm run serve`.

## Disclaimer

Unofficial, non-commercial fan project. Not affiliated with or endorsed by
Blizzard Entertainment. World of Warcraft is a trademark of Blizzard
Entertainment, Inc. Change text comes from Blizzard's official hotfix posts and
every entry links back to the original. Icons are loaded from Wowhead's icon
CDN and are not stored in this repository.
