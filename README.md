# fontphobia

Shrink a site's web fonts without changing how anything renders. See [PLAN.md](PLAN.md).

Status: **M1** (font core). `inspect` and the low-level `subset` work. The crawler, planner, `build`, `verify` and `check` are M2–M6.

```sh
pnpm install
pnpm test                      # unit, shaping-equivalence and golden-hash tests
pnpm --filter fontphobia build # bundles packages/cli/dist/cli.mjs + HarfBuzz WASM

node packages/cli/src/cli.ts inspect fixtures/fonts/InterVariable.ttf
node packages/cli/src/cli.ts subset fixtures/fonts/InterVariable.ttf --unicodes U+20-7E --features +tnum -o inter.ascii.woff2
```

Layout: `packages/core` (font I/O, inspect, subset, shaping equivalence; no browser), `packages/cli` (the published `fontphobia` package), `fixtures/fonts`, and `spikes/` (M0 research, not part of the build).
