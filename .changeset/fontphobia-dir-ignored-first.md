---
'fontphobia': patch
---

`.fontphobia/.gitignore` is written before anything else goes into `.fontphobia/`. It used to be written once the audit had finished, while the page-load cache (`.fontphobia/cache/visits/`) is written during the crawl. An audit that was interrupted or failed part-way, or one run with `--out-dir`, left the cache files where `git add -A` would commit them. `verify` likewise creates the file before writing diff images. Cache files a repository already tracks stay tracked: `git rm -r --cached .fontphobia/cache` untracks them.
