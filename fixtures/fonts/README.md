# Fixture fonts

Vendored for tests. Each file is pinned by sha256, and `fonts.test.ts` checks the hashes.

| File | Source | License | sha256 |
|---|---|---|---|
| `InterVariable.ttf` | Inter 4.1, `InterVariable.ttf` from https://github.com/rsms/inter/releases/tag/v4.1 (variable `opsz` 14–32, `wght` 100–900; unhinted) | OFL 1.1 (`Inter-LICENSE.txt`) | `4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf` |
| `Inter-Regular-hinted.woff2` | Inter 4.1, `extras/woff-hinted/Inter-Regular.woff2` from the same release (static, TrueType-hinted) | OFL 1.1 (`Inter-LICENSE.txt`) | `338239f6b590b8ced3bf857654d32da3fd3663294cd3003651ed57aa3abd7aa1` |
| `DejaVuSans.ttf` | DejaVu Sans 2.37 from https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37 (static, heavily hinted) | Bitstream Vera / DejaVu license (`DejaVu-LICENSE.txt`) | `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954` |
| `SourceSans3-Regular.otf` | Source Sans 3 3.052, `OTF/SourceSans3-Regular.otf` from https://github.com/adobe-fonts/source-sans/releases/tag/3.052R (static, name-keyed CFF; Reserved Font Name "Source") | OFL 1.1 (`SourceSans-LICENSE.txt`) | `08df266400933d3178d081a45f94a08814c3e55b4b7dd2e0ff69cb1329f13ab6` |
| `AND-Regular.otf` | Adobe NotDef 1.001, `AND-Regular.otf` from https://github.com/adobe-fonts/adobe-notdef/tree/1.001 (static, CID-keyed CFF with one Font DICT; every code point maps to a box) | OFL 1.1 (`AdobeNotDef-LICENSE.txt`) | `494bfaeeea8993a8f6fc8d21d2a9f4c6036dc51fb6e4938ff6f34ce5ad9dd7f2` |

Still to add (PLAN §15): Source Serif 4 (`opsz` and the Reserved Font Name "Source"), JetBrains Mono (`calt` code ligatures), and a font with Vietnamese and Romanian coverage.
