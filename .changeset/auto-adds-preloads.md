---
"fontphobia": minor
---

`fontphobia auto --crawl --allow add-preloads` preloads the core file of each face a page draws, where the page has no preload of it. It is an opt-in because a preload changes what the page loads first, and it needs the crawl because reading the built text can't tell which faces a page draws. `allow: ['add-preloads']` in the config does the same. `build` does not add preloads; it keeps pointing the ones a site has at the core file.

`--allow to-local` is now refused as an unknown opt-in. It was accepted and did nothing.
