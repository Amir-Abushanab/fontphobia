---
"fontphobia": patch
---

pr: 9

`audit --url` and `check --url` crawl sites served under a path prefix, such as a GitHub Pages project site. They used to visit only the home page.
