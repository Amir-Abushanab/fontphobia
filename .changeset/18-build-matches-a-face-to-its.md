---
"fontphobia": patch
---

pr: 9

`build` matches a face to its `@font-face` rule by descriptors before line number. A face it can't match after the stylesheet changed is reported and left unwritten.
