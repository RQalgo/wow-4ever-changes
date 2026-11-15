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

- Pick a class, then a talent tree (the labelled, indented *Talent tree* row
  that appears under the classes). A tree view also shows the class-wide and
  all-class lines, since those affect the tree too.
- *No classes* (next to *All classes*) hides every class change, i.e.
  everything published under Classes, and leaves only the category content
  (Items, Quests, Dungeons, ...), which the category chips then filter as
  usual. Picking a class or *All classes* shows class changes again. With
  *No classes* and category *None* nothing can match; the page says so and
  offers to show everything again.
- Category chips (Items, Quests, Dungeons, PvP, Media, ...) switch non-class changes
  on and off; only categories that occur in the data are shown, with quick
  *All* / *None*. A line can touch several classes: it is shown once, in its
  published section, with small chips for the other classes, *Talent* and
  other categories (tap a chip to filter by it). Up to four skill icons are
  shown per line; talents carry a small diamond mark.
- On phones the filters sit behind the filter button next to the search box
  (a badge counts active filters; a one-line summary appears when something is
  filtered). On wide screens they stay in the sidebar and cards flow in two
  columns.
- Tap the search box to get skill-name suggestions; type to narrow.
- Each date shows a **Hotfix**, **Patch** or **Dev Post** badge (patch days
  also show the patch title and a Source link). Use the *All / Hotfixes /
  Patches / Dev Posts* switch to show only one kind. On a shared date the
  order is patch, hotfix, dev posts.
- **Dev Posts** are posts by Blizzard staff (e.g. Kaivax, Community Manager)
  in the WoW: Forever General Discussion forum. A dev-post day has one *Dev
  Posts* card; each post is one line: the topic title links to the post (new
  tab), then the author ("· reply" for a staff reply inside a player thread),
  tag chips (classes, Talent, categories such as Dungeons or Media) and a short
  summary in Blizzard's words. Dev posts are not class changes: *No classes*
  keeps them; with a class picked they show when tagged with that class,
  otherwise the category chips decide, as for other lines. Search also finds
  them by author and by their tags (e.g. "mage").
- The view is stored in the URL, e.g.
  `#class=paladin&spec=retribution`, `#class=none` (no class changes),
  `#kind=patch`, `#kind=dev` or `#cats=items,quests` (enabled categories; `cats=none` for
  none; the old `general=0` still works), so it can be bookmarked or shared.
  `#filters=open` opens the filter sheet on phones. Without a hash the page
  restores the last class choice (a class and tree, or *No classes*) from the
  browser's local storage; the other filters are not remembered.

## How the data stays current

`.github/workflows/update-data.yml` runs every 3 hours, at minute 41 UTC
(00:41, 03:41, ... 21:41; an off-peak minute, because GitHub delays or skips
scheduled runs at busy times), and on demand from the Actions tab. It
downloads every source, parses it, looks up icons, and commits
`data/changes.json` when something changed. GitHub Pages (deploy from branch
`main`, root) then republishes by itself. Days that Blizzard later drops from
a source are kept.

Sources are listed in `data/sources.json`. There are three today: the rolling
hotfix post (`kind: "hotfix"`), Blizzard's forum topic of build notes
(`kind: "patch"`, one dated entry per Blizzard post), and the forum's
[Blizzard tracker](https://us.forums.blizzard.com/en/wow/g/blizzard-tracker/activity/posts)
(`kind: "dev"`, shown as **Dev Posts**): every staff post in *World of
Warcraft: Forever General Discussion* becomes one line with the thread title
(or "Reply in “…”"), a short summary in Blizzard's words, the author and a
link to the post. Its tags come from the whole post, not just the summary.
The tracker is read page by page back to the oldest stored date (at most 30
pages, 500 ms apart); a post's full text is fetched once, when it first
appears, and stored posts are kept when they drop off the tracker. When
Blizzard publishes a new patch-notes topic, add an entry like the existing
`discourse-topic` one with its forum URL; it is not discovered automatically.
If one source fails, the others still update and the failed source's stored
days are kept.

Icon lookups are rate-limited on purpose (250 Wowhead lookups per run, 1.5 s
apart) and cached in `data/icon-cache.json`; names that are still unknown are
retried on later runs. Names are looked up in the change text and its notes;
the game-client data index (when available) is the primary source and Wowhead
the fallback and cross-check. Lines without an icon show a class or category
tile. Every change also gets `tags` (classes, talent trees, categories) that
the filters use; they are recomputed for all days on every run.

Icons come from two sources. The primary one is the game client's own data
tables for the newest WoW: Forever build, published as CSV by wago.tools
(`scripts/gamedata.mjs`); it knows every spell, talent (with its tree and
class) and item by name, so it needs no per-name requests and is cached in
`.cache/gamedata/` (restored between workflow runs). Wowhead is the fallback
for names the tables do not have, and its talent calculator data
(`nether.wowhead.com/forever/data/talents-classic`, reused for 24 h) is used to
cross-check talent icons (`verified`) and to add talents the tables lack. Try
it locally with `node scripts/gamedata.mjs "Mortal Strike"`.

## Maintenance

- **Wrong or missing icon:** edit `data/icon-overrides.json`. Keys are
  lower-case names; a value of `{ "name", "type", "icon" }` forces an icon,
  `null` stops a word from being treated as a skill. The value may also carry
  `"kind"` (`talent`, `ability`, `spell`, `item`), `"class"` (class slug) and
  `"tree"` (talent-tree slug), which feed the class / spec tags.
- **Notes use another name than the game data:** add it to
  `data/name-aliases.json`, e.g. `{ "unsealed fury": "Unsealed Wrath" }` (key:
  lower-cased name as written; value: the name to look up). The subject keeps
  the written name and records `"alias"`.
- **Another forum category as dev posts:** in the `discourse-tracker` entry
  of `data/sources.json`, turn `categoryId` into a list and add the new
  category's id, e.g. `"categoryId": [347, 352]`. The id is the
  `category_id` of one of that category's posts in the tracker feed
  (`…/groups/blizzard-tracker/posts.json`). Its posts then appear as Dev
  Posts too. Use one entry with a list rather than a second entry: both would
  produce `kind: "dev"` days for the same dates, and days are keyed by date +
  kind, so one would replace the other.
- **Re-tag stored dev posts after a tag-rule change:** their full text is not
  stored, so they keep the tags they got when first fetched. Delete their
  `kind: "dev"` days from `data/changes.json`; the next run fetches the posts
  still on the tracker again.
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
