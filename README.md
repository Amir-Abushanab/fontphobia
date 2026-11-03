# fontphobia

Shrink a site's web fonts without changing how anything renders. See [PLAN.md](PLAN.md).

Status: **M6**. `audit` crawls a site in your installed Google Chrome and writes `.fontphobia/usage.json` and `report.md`. `build` plans the subsets from that file (no browser), shows the sizes, opt-ins and the diff, and `--write` writes the fonts, the CSS edits and `fontphobia.manifest.json` (css adapter). `verify` checks the written files and shaping, then compares every page before and after in Chrome, pixel for pixel. `check` says whether the subsets are still up to date (static, for a postbuild script or CI; `--url` crawls production). `fontphobia/vite` keeps the outputs out of asset inlining and warns in dev; `fontphobia/astro` runs `check` after the build. `revert` undoes the edits. The other adapters are M7.

```sh
pnpm install
pnpm test                      # unit, golden-hash and crawler tests (crawler tests need Google Chrome)
pnpm --filter fontphobia build # bundles packages/cli/dist + HarfBuzz WASM

node packages/cli/src/cli.ts audit --cwd path/to/site   # builds if needed (asks if the build is stale), crawls every page; reruns revisit only changed pages
node packages/cli/src/cli.ts build --cwd path/to/site   # plans from .fontphobia/usage.json; --write applies; --allow limit-axes etc.
node packages/cli/src/cli.ts verify --cwd path/to/site  # rebuilds if needed, compares before/after; diffs in .fontphobia/verify/
node packages/cli/src/cli.ts verify --hinting --browsers chromium,webkit,linux-firefox  # + Linux engines via Apple container / Docker / Podman
node packages/cli/src/cli.ts check --cwd path/to/site   # exits 1 with the reason and command when the subsets are out of date
node packages/cli/src/cli.ts revert --cwd path/to/site  # puts the original @font-face rules back
node packages/cli/src/cli.ts --cwd path/to/site         # audit + build, asks before writing, then verify
node packages/cli/src/cli.ts inspect fixtures/fonts/InterVariable.ttf
node packages/cli/src/cli.ts subset fixtures/fonts/InterVariable.ttf --unicodes U+20-7E --features +tnum -o inter.ascii.woff2
```

Framework fixtures (Astro, TanStack Start) have their own lockfiles:

```sh
(cd fixtures/sites/astro && pnpm install) && (cd fixtures/sites/tanstack-start && pnpm install)
FONTPHOBIA_SITES=1 pnpm vitest run packages/crawler/test/sites.test.ts packages/core/test/plan.test.ts
pnpm plans:update   # re-crawl the fixtures and rewrite fixtures/plans/*/{usage,plan}.json
```

Layout:
- `packages/core`: font I/O, inspect, subset, shaping equivalence, the CSS model, usage building, project detection and reports. No browser.
- `packages/crawler`: Chrome via `playwright-core`, the static server and server mode.
- `packages/cli`: the published `fontphobia` package.
- `fixtures/fonts` and `fixtures/sites`: test fonts and fixture sites.
- `spikes/`: M0 research, not part of the build.

Set `FONTPHOBIA_CHROME` to use a different Chrome or Chromium binary.
