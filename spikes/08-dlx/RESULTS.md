# Spike 8: `pnpm dlx` cold start

pnpm 12.9.1, macOS arm64, Node 24.21.0, system Chrome 155. Target: under 15 s.

## Setup

`pkg/` is a stand-in for the published package. Its `cli.mjs` measures the time to load the modules, run one WOFF2 compress of a 757 KB font, start Chrome and render a page.

| Contents                                                                                | Size        |
| --------------------------------------------------------------------------------------- | ----------- |
| harfbuzzjs 1.6.4 (both WASM files, bundles HarfBuzz 15.0.0)                             |             |
| wawoff2 2.0.1                                                                           |             |
| A 3 MB stand-in for the rest of the bundle (postcss, babel parser, CLDR data, our code) |             |
| A test font                                                                             |             |
| **Tarball total**                                                                       | **3.66 MB** |

The only dependency is `playwright-core@1.64.1`, the one dependency the plan doesn't bundle.

The cold run used a fresh, empty `store-dir` and `cache-dir`, so `playwright-core` was fetched from the registry. The tarball itself was local, so its download isn't included. At 3.7 MB that adds roughly 0.3–1 s on broadband.

## Answer

**About 4 s cold and 2.4 s warm, far under the 15 s target.**

|      | Total | Install / resolve | CLI: modules + WASM | CLI: Chrome up |
| ---- | ----- | ----------------- | ------------------- | -------------- |
| Cold | 4.1 s | ~1.2 s            | 24 ms               | ~1.1 s         |
| Warm | 2.4 s | ~0.1 s            | 20 ms               | ~0.5 s         |

The 1.6 s WOFF2 compress of a whole 757 KB font is real work, not startup. Loading the modules and WASM costs about 20 ms.

## Notes

- `playwright-core` (13 MB unpacked) is the biggest download, and it has no install scripts, so pnpm's build-script blocking doesn't apply. Bundling everything else keeps the cold path to one registry package.
- pnpm 12 enforces a minimum release age: spike 5 had to add `minimumReleaseAgeExclude` to install `next@16.4.4`. Not tested here, but if this applies to `dlx` too, `pnpm dlx fontphobia` would resolve to the previous version for about a day after each release. Check after the first publish. If it does, the README should say how to override pnpm's release-age setting for anyone who needs a release on day one. An exact version pin probably won't get around it.

## Implications for the plan

- §16 M0: answered. Make "cold `dlx` under 15 s" an M8 CI check against the real published tarball.
- §14: nothing to change.
