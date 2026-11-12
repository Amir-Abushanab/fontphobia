---
"fontphobia": patch
---

pr: 9

Static `check` decodes every HTML named character reference, leaves out `<title>`, and no longer stops on an out-of-range numeric reference.
