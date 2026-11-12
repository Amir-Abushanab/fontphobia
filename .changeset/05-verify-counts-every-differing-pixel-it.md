---
"fontphobia": minor
---

pr: 9

`verify` counts every differing pixel. It used to skip pixels that were classified as anti-aliasing, which hid changes on glyph edges. A difference that shows on one load and not on a reload is reported as `flaky` and doesn't fail the run; Chrome on macOS sometimes draws the corners of form controls this way.
