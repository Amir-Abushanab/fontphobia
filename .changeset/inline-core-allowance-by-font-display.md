---
"fontphobia": minor
---

`auto --allow inline-core` decides how much font the stylesheet may hold from each face's `font-display` and from what leads each page.

- With `block` (or `auto`, the default), text was hidden until the font arrived anyway: embedded, it showed as soon or sooner and shifted the layout less. So when every crawled page's largest contentful paint is text, the stylesheet may hold up to 96 KB of core files.
- A page led by an image keeps 16 KB: a hero photo that would have painted before the stylesheet arrived waits for it (a 29 KB photo showed at 1.0 s instead of 0.5 s).
- With `swap`, `fallback` or `optional`, pages painted text in a fallback font early and embedding takes that away, so the limit stays 16 KB. So does a run without `--crawl`.

The total counts every face embedded, smallest first, and the report says why a core stays a file. `audit` and `auto --crawl` now record each page's largest contentful paint (`text` or `image`) as `lcp` in `usage.json`.

`inlineCoreMax` takes `{ block, swap }` in bytes; a number sets both. In 0.6.0 it was a limit per file.
