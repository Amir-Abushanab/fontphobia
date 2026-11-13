---
"fontphobia": minor
---

Three opt-ins for `fontphobia auto`, each changing what a page loads and so off by default. `allow: [...]` in the config takes them too. `build` does not apply them.

- `--crawl --allow add-preloads` preloads the core file of each face a page draws, where the page has no preload of it.
- `--crawl --allow prefetch-extended` adds a `<link rel="prefetch">` of an extended file to the pages that don't need it, when another page does. A visitor who goes on to that page finds the file cached. Every visitor downloads it once.
- `--rules linked --allow inline-core` puts the core file of a face every page draws into the linked stylesheet as a `data:` URL, which saves its request. `verify` counts those bytes in each page's total.

The first two need the crawl, because reading the built text can't tell which faces a page draws.

`--allow to-local` is now refused as an unknown opt-in. It was accepted and did nothing.
