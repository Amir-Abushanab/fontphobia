---
"fontphobia": minor
---

`auto --allow inline-core` decides by `font-display` how much font the stylesheet may hold. With `block` (or `auto`, the default), text was hidden until the font arrived anyway: embedded, it showed as soon or sooner and shifted the layout less, so the stylesheet may hold up to 96 KB of core files. With `swap`, `fallback` or `optional`, pages painted text in a fallback font early and embedding takes that away, so the limit stays 16 KB. The total counts every face embedded, smallest first, and the report says why a core stays a file.

`inlineCoreMax` takes `{ block, swap }` in bytes; a number sets both. In 0.6.0 it was a limit per file.
