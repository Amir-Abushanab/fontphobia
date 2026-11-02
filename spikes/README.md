# fontphobia M0 spikes

Answers to the open questions in `../PLAN.md` §16. Each folder has a `RESULTS.md` (answer first, then evidence, then implications for the plan) and the scripts that produced it. The summary table is in PLAN.md §16.

```sh
cd spikes && pnpm install          # harfbuzzjs, wawoff2, fontkit, playwright-core, pixelmatch, pngjs
node 03-hb-subset/run.mjs          # most scripts run from spikes/ with the system Chrome
BUNDLED=1 node …                   # use Playwright's bundled Chromium instead (inside the Linux image)
docker run --rm -v "$PWD":/w -w /w -e BUNDLED=1 mcr.microsoft.com/playwright:v1.64.1-noble node 09-hinting/run.mjs linux --bundled
```

- `fonts/`: Inter 4.1 (OFL), DejaVu Sans 2.37 (free license). Fixture fonts only.
- `lib/hb.mjs`: HarfBuzz subset and shaping helpers, plus a serialized wawoff2 wrapper.
- `lib/sfnt.mjs`: a minimal table reader.
- `lib/browser.mjs`: Chrome launcher.
- `05-next-font/`, `06-*`, `07-*` and `10-*` are standalone packages with their own lockfiles.
