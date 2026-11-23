---
'fontphobia': patch
---

`verify` and `check` accept `--ci`. The top-level help lists the flag, and a CI script that passed it to every command got "Unknown option" from the two commands it is most likely to run. Neither prompts, so the flag changes nothing there.
