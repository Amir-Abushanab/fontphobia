---
"fontphobia": minor
---

`auto --allow inline-core` leaves a core file above 16 KB as a file. The stylesheet it goes into blocks rendering, so every byte in it delays the first paint: measured on a 1.6 Mbit/s link, 91 KB of core files there made it 0.95 s later. `inlineCoreMax` in the config sets the limit in bytes. The report also notes a face with `font-display: swap` or `fallback` whose core it embeds, since its pages used to paint text in a fallback font while the font loaded.

The README compares fontphobia with subfont, glyphhanger, cn-font-split and the subsetting libraries.
