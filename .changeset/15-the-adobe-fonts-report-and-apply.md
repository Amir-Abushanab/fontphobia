---
"fontphobia": patch
---

pr: 9

The Adobe Fonts report and `apply-kit --check` read the characters the pages use. They treated the recorded ranges as literal text, so the report always said the pages fit Adobe's Default character set.
