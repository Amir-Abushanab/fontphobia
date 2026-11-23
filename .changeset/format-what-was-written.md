---
'fontphobia': minor
---

After a write, `build` runs the project's own formatter over the files it touched, so a format check in CI passes without a second command.

What fontphobia writes can't be formatted in advance: oxfmt, Prettier and Biome each wrap the same long `unicode-range` differently, by the project's print width, quotes and indentation, and a rewritten `document.fonts.load()` call is one long line. The formatter used is the one the project declares in a package.json (or has a config file for) and has installed, at the project root or above it in a workspace: oxfmt, Prettier, Biome or dprint. Nothing is downloaded, a project without one is left as written, and a file the formatter ignores or refuses is skipped. `--no-format`, or `format: false` in the config, turns it off.

`revert` finds what fontphobia wrote after a formatter has been over it: a call broken over several lines, with a trailing comma added or grouping parentheses dropped, is still put back as it was.
