---
"fontphobia": patch
---

The automatic core choice runs again after the shaping repair. The repair can move most of a script's letters into core and leave a few behind, and the pages that use those few then downloaded the whole extended file for them. They now go in core when that costs less. On a 48-page test site with four Greek and four Russian pages, the mean font download per page fell from 70.8 KB to 60.0 KB. The next `build --write` can therefore write different files; `check` keeps passing against the files already built.
