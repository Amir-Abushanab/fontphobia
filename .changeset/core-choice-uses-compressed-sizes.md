---
"fontphobia": patch
---

The automatic core choice compares candidates by compressed size. It compared uncompressed sizes
before, which made a larger core look more expensive than it is: a larger file compresses better.
