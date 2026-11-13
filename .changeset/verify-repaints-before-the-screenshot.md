---
"fontphobia": patch
---

`verify` paints the whole page again before each screenshot. When the extended file arrived after a page had already painted with the core file, Chrome could leave one edge pixel of a glyph a single level off, so a comparison differed on one load and matched on the next, and `verify` reported it as flaky on every run. The result no longer depends on the order the font files arrive in.
