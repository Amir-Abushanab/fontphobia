---
'fontphobia': patch
---

`build` no longer undoes the project's formatter. It compared its marked block and the manifest with what it would write byte for byte, so once a formatter had wrapped a long `unicode-range` or put the manifest's short arrays on one line, every build reported an edit and `--write` put the unformatted text back. The block is now compared ignoring whitespace and the manifest by value. `check` and `verify` already read both by parsing them.
