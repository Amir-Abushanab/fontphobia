---
"fontphobia": patch
---

`verify` compares each page after painting all of it again, and reports what that changed. When the extended file arrived after a page had already painted with the core file, Chrome could leave one edge pixel of a glyph a single level off, so a comparison differed on one load and matched on the next, and `verify` reported it as flaky on every run. The comparison no longer depends on the order the font files arrive in. Pixels the page showed before the fresh paint are listed in a note with their count and size, because a visitor can get them too; they do not fail the run.
