# Data schema: `data/changes.json`

This file is the contract between the parser, the icon resolver and the web
app. Change it only together with all three.

```jsonc
{
  "generatedAt": "2026-11-15T00:10:00Z",       // ISO time of the pipeline run
  "source": {
    "title": "WoW: Forever Hotfixes",
    "url": "https://news.blizzard.com/en-us/article/24315281"
  },
  "days": [                                     // newest first
    {
      "date": "2026-11-13",                     // ISO date, used for sorting/anchors
      "label": "November 13, 2026",             // heading exactly as published
      "changes": [                              // in published order
        {
          "id": "2026-11-13-007",               // stable within a day: date + index
          "scope": "class",                     // "class" | "general"
          "category": "Classes",                // published category heading
          "class": "paladin",                   // lower-case class slug, or null
          "spec": "retribution",                // lower-case talent-tree slug, or null
          "group": null,                        // bold sub-heading inside a general
                                                //   category (e.g. a dungeon name), or null;
                                                //   nested headings joined with " › " (U+203A)
          "text": "Plain text of the change.",
          "notes": ["Developers' notes: ..."],  // zero or more follow-up notes
          "subjects": [                         // added by the icon resolver; [] before it runs
            { "name": "Judgement of Command",   // skill or item named in the text
              "type": "spell",                  // "spell" | "item"
              "icon": "ability_warrior_innerrage" } // Wowhead icon name, no extension
          ]
        }
      ]
    }
  ]
}
```

Rules:
- `scope` is `"class"` only when the line sits under a class heading inside the
  **Classes** category. Unlabelled lines directly under **Classes** have
  `scope: "class"`, `class: null` ("all classes"). Everything else is
  `"general"`.
- Class slugs: `druid hunter mage paladin priest rogue shaman warlock warrior`.
- Spec slugs are the lower-cased heading with spaces replaced by `-`
  (`retribution`, `beast-mastery`).
- The first entry of `subjects` supplies the line's icon. With no subjects the
  app falls back to a class or category icon.
- Icon image URL: `https://wow.zamimg.com/images/wow/icons/medium/<icon>.jpg`.

## Version 2: patch notes alongside hotfixes

Days now come from more than one source, listed in `data/sources.json`.

```jsonc
// data/sources.json — hand-edited list of sources, processed in order
[
  { "kind": "hotfix", "type": "news-rolling",          // the rolling hotfix post (dates inside the page)
    "url": "https://news.blizzard.com/en-us/article/24315281" },
  { "kind": "patch",  "type": "discourse-topic",       // a Blizzard forum topic; one day per staff post
    "url": "https://us.forums.blizzard.com/en/wow/t/2360696",
    "title": "Beta build notes" }
]
```

Each **day** gains three fields:

```jsonc
{
  "date": "2026-11-02",
  "kind": "patch",                 // "hotfix" | "patch"  (missing = "hotfix" for old data)
  "title": "Beta build notes",     // optional short name of the patch/post, or null
  "sourceUrl": "https://us.forums.blizzard.com/en/wow/t/2360696/9",  // link to this day's post
  "label": "November 2, 2026",
  "changes": [ /* unchanged shape */ ]
}
```

Rules:
- A day is identified by `date` + `kind`: a patch and a hotfix on the same date
  are two separate days. Order: newest date first; on the same date the patch
  comes before the hotfix.
- Change ids: hotfix days keep `<date>-NNN`; patch days use `<date>-pNNN`.
- Patch-note dates are the post's creation time converted to US Pacific time
  (Blizzard's own dating), formatted like hotfix labels ("November 2, 2026").
- Under **Classes**, a sub-heading is a `spec` only when it is a real talent
  tree of that class (see the list in the parser); any other sub-heading
  (e.g. "Pets", a race name) becomes `group`.
- Extra categories appear in patch notes (e.g. "Bugfixes", "Races",
  "Gamepad Support", "Known Issues"); they are all `scope: "general"`.

## Version 3: tags, richer subjects

Every change gains `tags`, and subjects gain `kind` and `class`. The section a
line was published under (`scope`/`category`/`class`/`spec`/`group`) is
unchanged; tags are what the filters use, so one line can belong to several
classes and categories at once.

```jsonc
{
  "id": "2026-11-13-031",
  "scope": "class", "category": "Classes", "class": "shaman", "spec": null, "group": null,
  "text": "Windfury Totem is now correctly activated by all melee abilities …",
  "notes": ["Developers’ notes: … Whirlwind or Mutilate …"],
  "subjects": [
    { "name": "Windfury Totem", "type": "spell", "kind": "ability", "class": "shaman", "icon": "spell_nature_windfury" },
    { "name": "Whirlwind",      "type": "spell", "kind": "ability", "class": "warrior", "icon": "ability_whirlwind" },
    { "name": "Mutilate",       "type": "spell", "kind": "talent",  "class": "rogue",   "icon": "ability_rogue_shadowstrikes" }
  ],
  "tags": ["class:shaman", "class:warrior", "class:rogue", "talent"]
}
```

Subject fields:
- `type`: `"spell"` | `"item"` (as before).
- `kind`: `"talent"` | `"ability"` | `"item"` | `"spell"` (spell of unknown sort).
- `class`: class slug the skill belongs to, or `null`.
- Subjects are found in the change text **and its notes**; text subjects come first.

Tag vocabulary (all lower-case):
- `class:<slug>` — the published class heading, plus the class of every
  talent/ability subject, plus classes named in the text or notes
  ("Shaman quest reward", "rogues").
- `spec:<class>/<tree>` — the published talent-tree heading (e.g. `spec:paladin/retribution`).
- `talent` — at least one subject is a talent, or the text is about a talent
  ("New Talent", "talent", "Row 4").
- Exactly one or more **category tags** for non-class content, mapped from the
  published category and from the text:
  `items`, `quests`, `dungeons` (dungeons and raids), `professions`, `pvp`,
  `ui` (User Interface, Cooldown Manager, Gamepad Support, accessibility),
  `world` (World, Enemies and NPCs, zones), `races`, `events`, `systems`
  (Legacy system, perks, camps, experience; since v4 also realms, servers,
  login, queues, botting, RMT, gold buying, accounts), `media` (dev posts
  only, since v4: podcasts, livestreams, videos), `bugfix`, `known-issue`,
  `other`.
  A class line gets a category tag too when its text is clearly about one
  (e.g. a class quest → `quests`).
- Every change has at least one tag. A change published outside **Classes**
  always has at least one category tag.

Filter semantics used by the app:
- Class filter `X`: changes tagged `class:X`, plus all-class lines (published
  under Classes with no class heading and no `class:` tag).
- Tree filter `X/T`: changes tagged `spec:X/T`, plus changes tagged `class:X`
  that have no `spec:X/…` tag, plus all-class lines.
- Category chips: a change with no `class:` tag is shown when at least one of
  its category tags is switched on. With a class selected, class-tagged
  changes are always shown regardless of the category chips.
- Class choice "No classes" (hash `class=none`, the third option beside
  "All classes" and one class): hides every **class change**, i.e. every line
  published under **Classes** (`scope` is not `"general"`: class and tree
  headings and the all-class lines), even when it also has a category tag
  (a Paladin quest line tagged `quests` stays hidden). Every other line is
  shown when at least one of its category tags is on; while classes are
  hidden its `class:` tags no longer exempt it from the chips, so "No
  classes" together with no categories shows nothing (the app says so and
  offers a reset). Choosing "All classes" or a class turns the hiding off;
  choosing "No classes" clears any selected class and tree.
- Why the published section and not the `class:` tags decides what a class
  change is: in the data of 2026-11-15, 36 of the 524 lines published outside
  Classes carry a `class:` tag, and roughly a third of those mention a class only
  in passing (a dungeon boss's "Shield Slam", a racial trait, an item that
  shares a cooldown with Sprint). Hiding them would take lines away from
  categories the reader left switched on — 8 of 26 known issues and 8 of 47
  race lines, for example. They stay visible, still showing their class chip.
  Consequence: "All classes" + no categories and "No classes" + all
  categories overlap in those lines; the two views are not exact complements.

### Version 3 addendum: two icon sources

Skill and item data now comes from two sources:
1. **client** — the game client's own data tables for the newest WoW: Forever
   build, published as CSV by wago.tools (`scripts/gamedata.mjs`). Primary
   source: no per-name requests, knows talents, talent trees and classes.
2. **wowhead** — Wowhead's search suggestions (rate-limited). Fallback for names
   the client index does not have, and a cross-check for names it does.

Subjects therefore gain three optional fields:

```jsonc
{ "name": "Oath of Light", "type": "spell", "kind": "talent", "class": "paladin",
  "tree": "holy",          // talent tree slug for talents, else null/absent
  "icon": "spell_holy_greaterblessingoflight",
  "source": "client",      // "client" | "wowhead" | "override"
  "verified": true }       // true when both sources returned the same icon;
                           // false when they disagree; absent when only one answered
```

Tags: a talent subject with a `tree` also adds `spec:<class>/<tree>`, so a
Retribution talent mentioned in a class-wide Paladin line is found by the
Retribution filter.

## Version 4: dev posts (Blizzard staff forum posts)

A third kind of day, `kind: "dev"`, holds posts by Blizzard staff from the
forum's **Blizzard tracker** (`https://us.forums.blizzard.com/en/wow/g/blizzard-tracker/activity/posts`)
that are in the category **World of Warcraft: Forever General Discussion**
(`category_id` 347). Source entry in `data/sources.json`:

```jsonc
{ "kind": "dev", "type": "discourse-tracker",
  "url": "https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json",
  "categoryId": 347,
  "title": "Dev Posts" }
```

Facts about the endpoint (checked 2026-11-15):
- `GET …/groups/blizzard-tracker/posts.json` → `{ posts: [ … ] }`, 20 per page, newest
  first; older pages via `?before_post_id=<id of the last post on the page>`.
  Each post: `id, created_at, topic_id, topic_title, topic_slug, url, category_id,
  post_number, posts_count, post_type, username, name, user_title,
  primary_group_name, excerpt, truncated`. The excerpt is cut (~300 chars).
- Full body: `GET https://us.forums.blizzard.com/en/wow/posts/<id>.json` → `{ cooked, … }`.
- 62 posts in category 347 between 2026-09-18 and 2026-11-15: announcements
  (post_number 1) and staff replies inside player threads (post_number > 1).

Dev-post days and changes:

```jsonc
{ "date": "2026-11-14",        // US Pacific calendar date of created_at
  "kind": "dev", "title": null, "sourceUrl": null, "label": "November 14, 2026",
  "changes": [
    { "id": "2026-11-14-d001",
      "scope": "general", "category": "Dev Posts", "class": null, "spec": null, "group": null,
      "text": "Player-Level Dungeon XP Adjustment - November 14",   // topic title
      "notes": ["Yesterday, we updated dungeon play so that …"],    // summary, see below
      "url": "https://us.forums.blizzard.com/en/wow/t/player-level-dungeon-xp-adjustment-november-14/2416343/1",
      "author": "Kaivax", "authorTitle": "Community Manager",
      "postNumber": 1,             // 1 = the announcement itself; >1 = a staff reply in a thread
      "subjects": [ … ], "tags": [ … ] } ] }
```

Rules:
- One change per tracker post. For a reply (`postNumber > 1`) the text is
  `Reply in “<topic title>”`.
- `notes` holds a SHORT summary in Blizzard's words: the first one or two
  paragraphs of the post body, at most 400 characters in total, cut at a word
  boundary with "…" — never the whole post (long posts are read at `url`).
  Quotes of other users (`<aside class="quote">`) and images are dropped.
- Subjects and tags are computed from the title + the plain text of the whole
  post body (not just the summary), with the normal rules: classes, trees,
  talents, category tags (dungeons, pvp, quests, …). A dev-post change is
  never a "class change" (it is not published under Classes), so "No classes"
  does not hide it; it follows the category chips like other general lines.
- Ids: `<date>-dNNN`. Day order on the same date: patch, then hotfix, then dev.
- Stored dev-post days are kept when posts fall off the tracker's pages (same
  merge rule as other sources); a post already stored (same `url`) is not
  re-fetched.

UI: badge "Dev Post", kind filter gains a fourth option "Dev Posts"
(hash `kind=dev`); each dev-post line links to its `url` and shows the author.

### Version 4 addendum: pipeline details (2026-11-15)

Transient field `_fullText` (never in `data/changes.json`):
- `scripts/sources.mjs` sets `change._fullText` on every freshly fetched dev
  post: the topic title, then every text block of the post body (paragraphs,
  headings, list items; quotes of other users, link previews and images
  removed), one block per line.
- `scripts/icons.mjs` takes subjects from `text` and the lines of
  `_fullText` (instead of the summary `notes`); `scripts/tags.mjs` adds it to
  the texts its rules read.
- `scripts/update.mjs` deletes it (`TRANSIENT_FIELDS`) before comparing and
  writing the file. Any future transient field must start with `_` and be
  listed there.
- A stored dev post is not fetched again, so it has no `_fullText` on later
  runs; it keeps its stored `subjects` and `tags` instead of being re-tagged
  from its title and summary. (Rule changes therefore do not revise stored
  dev posts; removing a dev day from the file makes the posts still on the
  tracker be fetched and tagged again.)

Source entry: `categoryId` may also be a list (`[347, 352]`) to keep several
forum categories from the one feed; all their posts become Dev Posts.

Tracker paging (`discourse-tracker`): pages are read with `before_post_id`
until a page is empty, or a page's oldest post is older than the cutoff
(default: the oldest date of any stored day, or 2026-09-01 when nothing is
stored), or 30 pages; 500 ms between requests. Posts older than the cutoff
and posts with a `post_type` other than 1 are dropped. A body that cannot be
fetched falls back to the feed's excerpt.

Tag rule changes:
- `media` (new): only for dev posts (category "Dev Posts").
- `systems`: realms, servers, login, queues (not "spell queue"), botting,
  bots, RMT, gold buying / selling, accounts (not "to account for", "Bound to
  Account"). `pvp`: also "faction balance".
- NPC abilities: outside **Classes**, a subject written as the possession of
  a capitalised name that is not a class word ("Deathless Guardian's Shield
  Slam", "Deathless Sorcerer’s Fireball") keeps its icon but adds no `class:`,
  `spec:` or `talent` tag, and such a line never gets `talent`.

Parser rules:
- `group` separator is " › " (U+203A with spaces), as in the UI; stored days
  that no source re-parses are normalised from the old " > " on every run.
- An item whose own text ends with `.` `!` `?`, has more than 6 words, or
  starts with the category name followed by a lower-case word is never a
  heading (class, spec, group or category): it is a change, and its nested
  items are its notes. A sub-heading equal to the category adds no group.
