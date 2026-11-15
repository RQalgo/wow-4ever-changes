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
                                                //   category (e.g. a dungeon name), or null
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
  (Legacy system, perks, camps, experience), `bugfix`, `known-issue`, `other`.
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
