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
