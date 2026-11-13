---
"fontphobia": minor
---

`fontphobia auto` subsets the fonts of a built site inside its output directory. It edits no source file, writes no manifest and leaves nothing to commit; run it after every build. By default it reads the built text without a browser. `--crawl` measures each face in Chrome and writes the same files the default flow does.

The split rules go in a `<style>` at the end of each page's `<head>`. The original `@font-face` rules stay as the fallback for pages without them, and the original fonts no longer download on pages that have them. A font whose pages would not download less is left alone. `--rules linked` (config `autoRules`) puts the rules in one cached stylesheet, `fontphobia.<hash>.css`, instead. Every run checks the written files and shaping without a browser and puts the output back if a check fails. `--verify` adds the pixel comparison.

Every framework integration takes `auto: true` or `auto: 'crawl'`, which replaces its post-build `check`. The config's new `auto` key sets it for all of them, including the Next adapter.
