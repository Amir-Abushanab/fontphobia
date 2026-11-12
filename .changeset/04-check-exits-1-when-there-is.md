---
"fontphobia": minor
---

pr: 9

`check` exits 1 when there is no `.fontphobia/manifest.json` to check against, and `check --url` exits 1 when a page can't be loaded. `--mode warn` reports both without failing. For a missing manifest, the framework integrations log a warning and let the build finish.
