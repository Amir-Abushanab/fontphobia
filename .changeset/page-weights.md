---
'fontphobia': minor
---

`pageWeights` in the config says how much each page counts when `coreThreshold: 'auto'` chooses core. The choice minimizes what all pages download together and counted every page once, so it would leave the home page fetching a 41.7 KB extended file for four characters to save 1.1 KB on each of 58 pages hardly anyone opens. `pageWeights: { '/': 20 }` counts the home page as twenty: by page path, glob or `'*'`, a whole number from 0 to 1000, default 1. `build` and `auto` read it, and the plan's list of pages that would download more than before points to it.
