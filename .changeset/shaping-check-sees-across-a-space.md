---
"fontphobia": patch
---

The shaping check now sees a symbol together with the words on each side of it. A font can pick a glyph from what stands across a space: Inter draws a raised "±" or "×" between digits or capitals ("1 ± 2") and the plain one elsewhere. With the symbol in the extended file and the digits in core, the browser drew the plain one, and only `verify` caught it. `audit` now records such a symbol with its neighbours, so the plan moves it into core. The next `audit` adds these to `usage.json`.
