---
"fontphobia": minor
---

`build` now chooses each font's core file by measurement. A character that pages use goes in core when that makes the font's pages download less in total, and in the extended file otherwise. Before, a character went in core only if at least half of the font's pages used it, so one accented letter on one page made that page download the whole extended file. The plan report lists what was put in core and how many pages then load only the core file.

`coreThreshold` defaults to `'auto'`. A number from 0 to 1 keeps the fixed rule, and `coreThreshold: 0.5` is the old behavior. `build --core-threshold <auto|share>` sets it for one run. The next `build --write` after upgrading can therefore write different files; `check` keeps passing against the files already built.
