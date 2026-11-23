---
'fontphobia': minor
---

`extraText` in the config declares text the crawl can't see. A script that adds text after the page has loaded (a weather label's "9°C" after a fetch) leaves characters the audit never records: the plan treats them as unused, they land in the extended file, and the page downloads that whole file for one character. `extraText: { '/': '°C' }` counts the text as drawn on that page, by path, glob or `'*'`, in every face the page draws or in the families you name (`{ '/': { 'Geist Mono': '°C' } }`), so the core choice can put its characters in core. `build` and `verify` read it; a pattern or family that matches nothing the audit saw is reported.
