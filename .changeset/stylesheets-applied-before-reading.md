---
'fontphobia': patch
---

An audit waits for each page's stylesheets to be applied before reading its text. A visit went on once no request was in flight, and a stylesheet can finish downloading before the page has applied it, so on a slow machine a visit could read the page in the browser's default font and report its text as drawn by a system font. Seen on Windows CI in the font-size sweep visits, which skip the scroll.
