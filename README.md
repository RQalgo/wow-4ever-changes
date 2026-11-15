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

## Disclaimer

Unofficial, non-commercial fan project. Not affiliated with or endorsed by
Blizzard Entertainment. World of Warcraft is a trademark of Blizzard
Entertainment, Inc. Change text comes from Blizzard's official hotfix posts and
every entry links back to the original. Icons are loaded from Wowhead's icon
CDN and are not stored in this repository.
