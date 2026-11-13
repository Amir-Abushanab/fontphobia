# Spike 5: `next/font` in Next 16

Run on 2026-11-02 with `next@16.4.4`, React 19.3.1, Node 24.21.0, macOS. The fixture app is `app/fonts.js` (each case documented inline) plus `app/page.jsx`. Builds were run with `pnpm build` (Turbopack) and `pnpm build:webpack`. Evidence is in `evidence/`.

## Answers

1. **`next/font/google`**
   - **`weight`:** omitted (same as `'variable'`), a string from the font's list (`'400'`), or an array of those strings (`['400','700']`).
     - Rejected: numbers (`400`), ranges in either syntax (`'100 900'`, `'100..900'`), and `'variable'` mixed into an array.
     - A variable request always asks Google for the full `wght` range. You can't ask for a sub-range.
   - **Static weights on a variable family still download the full variable file.** `weight: ['400','700']` emits two `@font-face` rules, `font-weight: 400` and `font-weight: 700`, but both point at the same 100..900 file that the variable call gets.
   - **`axes: ['opsz']`:**
     - Adds the axis at its full range (`opsz,wght@14..32,100..900`).
     - Latin file: 48,432 B with `wght` only → 73,016 B with `opsz` 14..32 and `wght`. Same glyphs and cmap.
     - **Without `axes`, Google's Inter has no `opsz` axis.** Optical size is pinned at 14, so `font-optical-sizing` does nothing.
     - `axes` can't include `wght`, and is rejected when `weight` is set.
   - **`subsets` only chooses which files are preloaded.** Every slice Google returns is downloaded, emitted and declared with Google's `unicode-range`: 7 slices for Inter, 6 for Roboto Flex. Only the listed subsets get `<link rel=preload>`. `subsets` is required unless `preload: false`.
   - **Emitted CSS:** Google's rules, with `src` rewritten to `/_next/static/media/<hash>-s[.p].woff2` and `format("woff2")`. `font-display: swap` is the default. Variable faces get range descriptors (`font-weight: 100 900`, `font-stretch: 25% 151%`).
   - **Family names are not scoped in Next 16, on either bundler:** `font-family: Inter`, not `__Inter_<hash>`.
     - So three `Inter()` calls in one app declare three sets of `Inter` faces that collide. Plain, `opsz` and static each have identical descriptors, so whichever is declared last wins.
     - Webpack merges the three class rules into one. Turbopack keeps them separate but uses the same family.
   - **Network:** fetched at build time, with no cache of its own (only in-memory `Map`s per process).
     - Webpack fetches from JS; Turbopack fetches from Rust. A clean build with no network **fails on both** (exit 1, "Failed to fetch `Inter` from Google Fonts").
     - A rebuild with `.next/cache/{webpack,turbopack}` present **succeeds offline**, because the bundler's persistent cache holds the result.
     - `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` (a JS file mapping URL → CSS) replaces the CSS fetch. It's read by both bundlers, but it covers only the CSS: the font files are still downloaded, per `fetch-css-from-google-fonts.js`.

2. **`next/font/local`**
   - **CSS shape:** one `@font-face` per `src` entry. Properties are written in this order:
     1. `declarations`
     2. `font-family` (the JS binding name, e.g. `interLocal`; skipped if `declarations` sets one)
     3. `src: url(...) format(...)`
     4. `font-display`
     5. `font-weight`/`font-style` (from the entry, else the top level)

     Then a single `<name> Fallback` face, unless `adjustFontFallback: false`.

   - **`declarations`:** applied to every face of the call. Only `src`, `font-display`, `font-weight` and `font-style` are rejected. `unicode-range` and `font-family` are allowed.
   - **No `unicode-range` per `src` entry.** I tried `{ path, weight, unicodeRange, declarations }` on each entry. TypeScript would reject the extra keys; at runtime they are silently dropped, because the loader only reads `path`/`weight`/`style`. Both faces were emitted with no `unicode-range` and both were preloaded.
   - **One `unicode-range` per call does work.** The split can be expressed as **two `localFont()` calls** sharing a family set in `declarations` (`font-family: 'Inter Split'`), each with its own `unicode-range`. But:
     - **Webpack:** works. `className`, `style` and `variable` all reference `'Inter Split', 'Inter Split Fallback'`.
       - The extended call needs `adjustFontFallback: false`. Otherwise it emits a second `Inter Split Fallback` face, computed from the extended file (size-adjust 100%), and the later declaration wins.
       - It also needs `preload: false`.
     - **Turbopack (the default):** broken. The `@font-face` uses `Inter Split`, but `className`, `style` and `variable` still reference the binding name (`splitCore, splitCore Fallback`). That family doesn't exist, so the font never applies. Fallback faces are emitted under the binding name too.
   - **`adjustFontFallback`:**
     - `'Arial'` (default) or `'Times New Roman'` selects the reference fallback. `false` emits no fallback face.
     - With several `src` entries, the metrics come from one file, chosen by `pickFontFileForFallbackGeneration`: closest to weight 400, prefers normal style, and on a tie **the later entry wins**.
     - In the `interLocal` case, both entries are `100 900`, so the metrics came from the latin-ext file. It has no a–z, so size-adjust fell to 100%.

3. **Fallback metrics**
   - **Google:** a precomputed table. `next/dist/server/font-utils.js` `calculateSizeAdjustValues()` reads `next/dist/server/capsize-font-metrics.json` (1,753 families): `ascent`, `descent`, `lineGap`, `unitsPerEm`, `xWidthAvg`, `category`. It compares against Arial (sans) or Times New Roman (serif) from the same table. The Turbopack binary embeds the path to the same JSON. **The font file never affects it**, so subsetting or instancing a Google font doesn't change the fallback CSS. Inter → `size-adjust:107.12%; ascent-override:90.44%; descent-override:22.52%`.
   - **Local:** computed from the actual file. `next/dist/compiled/@next/font/dist/local/get-fallback-metrics-from-font-file.js` uses Next's bundled fontkit:
     - `font.ascent`/`descent`/`lineGap` (hhea) and `unitsPerEm`.
     - The average `advanceWidth` of the default instance for `'aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      '`, compared with hardcoded Arial/Times averages.
     - If any of those characters is missing, `size-adjust` falls back to 100% and the overrides are left unscaled.
     - Turbopack and webpack produced identical numbers.
   - **Would fontphobia change it? Yes, for local fonts, in three ways** (`scripts/fallback-metrics.cjs`, output in `evidence/fallback-metrics.txt`):

     | File                                      | size-adjust | ascent-override    |
     | ----------------------------------------- | ----------- | ------------------ |
     | original Inter latin                      | 107.89%     | 89.79%             |
     | subset to Latin-1 or ASCII, no instancing | 107.89%     | 89.79% (unchanged) |
     | ASCII without `q`                         | **100.00%** | **96.88%**         |
     | `wght` 300..700 (default 400 kept)        | 107.89%     | 89.79% (unchanged) |
     | `wght` 500..700 (default clamps to 500)   | **109.05%** | **88.83%**         |
     | `opsz` pinned at 14 (the default)         | 107.89%     | 89.79% (unchanged) |
     | `opsz` 16..32 (default clamps to 16)      | **106.82%** | **90.69%**         |
     | `opsz` pinned at 32                       | **98.29%**  | **98.56%**         |

     hhea stayed 1984/-494/0 in every case.

     So fontphobia changes the fallback face if it:
     1. drops any of a–z or space from the file Next measures;
     2. limits an axis range so that it excludes the default (the default moves, so advance widths change);
     3. puts a file without a–z last among equal-weight entries.

4. **Bundler**
   - **`next build` uses Turbopack by default in 16.4.4** (banner `▲ Next.js 16.4.4 (Turbopack)`). `--webpack` opts out.
   - **The same on both:** Google URLs, downloaded files, `unicode-range`, preload selection and fallback numbers.
   - **Different:**
     - Turbopack ignores a `declarations` `font-family` in `className`/`style`/`variable` (above).
     - Turbopack emits one fallback face per call; webpack dedupes them.
     - File names: Turbopack `<name>-s.p.<hash>.woff2`; webpack `<hash>-s.p.woff2`.
     - Turbopack fetches Google from Rust (`internal/font/google`), with different warning text.
     - Number formatting: `0.0%` vs `0.00%`; webpack lowercases `unicode-range`.
     - Both emit a file twice when two calls preload it differently (`…-s.p.woff2` and `….woff2`).

## Evidence

- `evidence/emitted.turbopack.css` and `evidence/emitted.webpack.css`: the full emitted CSS, one rule per line.
- `evidence/preloads.turbopack.html`: the `<link rel=preload>` tags. Webpack's are the same set of five: the two Inter latin files, Roboto Flex latin, and the two local files.
- `evidence/google-options.txt`: next/font/google's own validator and URL builder (`scripts/google-options.cjs`) run on 15 option sets.
- `evidence/google-files.txt`: axes and sizes of the downloaded files (`scripts/inspect-google-files.cjs`).
- `evidence/fallback-metrics.txt`: Next's local fallback code on subset and instanced files.
- Source read (all under `node_modules/next/dist/`):
  - `compiled/@next/font/dist/google/{loader,validate-google-font-function-call,get-font-axes,get-google-fonts-url,find-font-files-in-css,fetch-css-from-google-fonts,fetch-resource,get-fallback-font-override-metrics}.js`
  - `compiled/@next/font/dist/local/{loader,validate-local-font-function-call,get-fallback-metrics-from-font-file,pick-font-file-for-fallback-generation}.js`
  - `server/font-utils.js`, `server/capsize-font-metrics.json`
- Offline tests: built with `HTTPS_PROXY=http://127.0.0.1:9`, which `get-proxy-agent.js` honors and the Turbopack fetch also hit.

Excerpts:

```css
/* google, subsets:['latin'] (Turbopack): 7 slices, only latin preloaded (.p) */
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(../media/07c7676b89ed2778-s.p.2bn3s6zvc0dyp.woff2)format("woff2");unicode-range:U+??,U+131,…}
@font-face{font-family:Inter Fallback;src:local(Arial);ascent-override:90.44%;descent-override:22.52%;line-gap-override:0.0%;size-adjust:107.12%}

/* split via declarations: webpack works */
@font-face{font-family:Inter Split2;unicode-range:u+00??;src:url(/_next/static/media/5678e9b0dc22dee2-s.p.woff2) format("woff2");font-display:swap;font-weight:100 900}
@font-face{font-family:Inter Split2 Fallback;src:local("Arial");ascent-override:89.79%;descent-override:22.36%;line-gap-override:0.00%;size-adjust:107.89%}
.__variable_5f85c0{--font-split:"Inter Split2","Inter Split2 Fallback"}
@font-face{font-family:Inter Split2;unicode-range:u+0100-024f;src:url(/_next/static/media/0fa6be33b6118538.woff2) format("woff2");font-display:swap;font-weight:100 900}

/* same source, Turbopack: class and variable point at a family that doesn't exist */
@font-face{font-family:Inter Split2;unicode-range:U+??;src:url(../media/inter_latin_opsz_normal-s.p.34fk6-9m1aguk.woff2)format("woff2");…}
.TAK6fa_className{font-family:splitCoreVar,splitCoreVar Fallback}
.TAK6fa_variable{--font-split:"splitCoreVar", "splitCoreVar Fallback"}
```

## Implications for the plan

Suggested edits; not applied.

- **§6.3 `next-font-local`:**
  - Replace "the core/extended split isn't possible" with: it's possible as two `localFont()` calls sharing a `declarations` `font-family`, each with its own `unicode-range`. The extended call sets `preload: false` and `adjustFontFallback: false`.
  - This works only under webpack. Under Turbopack (Next 16's default) `className`/`variable` ignore the declared family. So the adapter must detect the bundler (the `--webpack` flag in the build script, or `next.config` `turbopack` settings) and refuse or warn on Turbopack.
  - The other route on Turbopack: subset in place (one file per call, no split), or write plain CSS `@font-face` through the `css` adapter and remove the `localFont()` call. The second changes what the user's code looks like, so treat it as opt-in.
  - Spike 2 should also check Chrome's behavior with two same-descriptor faces and no `unicode-range` (the silently dropped per-entry case).
- **§6.3 fallback guarantee:** next/font/local computes the fallback face from the file. To keep "fallbacks unchanged":
  1. The file Next measures (the one `pickFontFileForFallbackGeneration` picks, the later entry on ties) must keep a–z and space.
  2. Axis limits must keep each axis's default inside the range (or the planner must keep the default instance's advances).
  3. hhea must be unchanged.

  Add these checks to the planner for this adapter. Better still, compute Next's fallback CSS before and after with Next's own function (`getFallbackMetricsFromFontFile`, loaded from the user's `next`) and require equality. That makes it a deterministic check rather than a promise.

- **§6.4 `next-font-google`:**
  - The fallback comes from a precomputed table, so fontphobia's changes can't alter it. But fontphobia can't feed Google a subset either.
  - `subsets` affects only preload; every slice is always downloaded and emitted. `weight` can't name a range, and static weights get the full variable file.
  - So the only byte savings available while staying on `next/font/google` are `preload` choices and removing unused `axes`. Real savings need conversion to `next/font/local` (downloading the file once) or to the `css` adapter. Conversion then has to recreate the fallback with the same numbers. The table values are reachable via `next/dist/server/font-utils.js` `calculateSizeAdjustValues`, so put them in `declarations` (`adjustFontFallback: false` plus a hand-written fallback face via the css adapter) or keep `adjustFontFallback` and accept local's recomputed values. These differ slightly: Inter 107.12% from the table vs 107.89% from fontkit. **So conversion changes the fallback unless fontphobia writes the fallback face itself.** Record that as the reason this conversion is opt-in.
  - Note that default Google Inter has no `opsz` axis. A baseline built from `next/font/google` without `axes` is an `opsz`-less font, and §8.6's opsz sweep doesn't apply.
- **§6.4/§10.3 baselines:** the baseline build needs network or a warm `.next/cache`. In `verify`'s worktree baseline, either copy `.next/cache` or point `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` at captured CSS. Font files are still fetched, so offline baselines need the cache.
- **§6 detection:** Next 16 doesn't scope family names, so multiple calls for the same Google family collide in the cascade (last declared wins). The audit should resolve faces from the live page (`CSS.getPlatformFontsForNode` plus the computed `@font-face` list), not from the call sites, and report collisions.
- **§12 / M6:** the plan already uses `check` in `postbuild` because Next 16 uses Turbopack. That's confirmed; also note `--webpack` exists if a project opts into the webpack-only split.
