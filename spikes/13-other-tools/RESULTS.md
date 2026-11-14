# Spike 13: fontphobia next to subfont, and fonts as `data:` URLs

November 2026, macOS arm64, Chrome 157, Node 26.13.1. fontphobia at 0.5.0 (run from source), subfont 7.3.0. Site: `examples/bakery` (4 pages, Inter variable and Fraunces), and a 204-page copy of it with 200 generated journal pages linked from the home page. The scripts are not kept; the method is described under each part.

## Answers

1. **subfont's subsets render differently from the original fonts on macOS.** Every page differed at 1× (22,000 to 53,000 pixels, up to 139 of 255 levels in small text); fontphobia's output in all three modes did not differ in any of 16 comparisons.
2. **The cause is in the subsets, not in subfont's approach.** Its subsets drop glyph names and lack the glyphs named "X" and "o", which macOS looks up by name. Subsets of the same characters with glyph names kept reduced the difference; with the two glyphs as well, it was 0. fontphobia's `verify` found both earlier: the glyph-names flag in `packages/core/src/subset/subset.ts` and the reference glyphs in `packages/core/src/plan/hintrefs.ts`.
3. **Chrome makes fontphobia's files smaller by about a quarter here, and costs most of its run time.** Without a browser (`auto`) a page downloads 124 KB of fonts; with the crawl, 91 KB. The crawl takes about 1.4 s per page.
4. **About 90% of fontphobia's run time without a browser is WOFF2 compression,** so it barely grows with the number of pages.
5. **Fonts in a stylesheet as `data:` URLs delay the first paint by about the time the fonts take to download.** The final fonts arrive about when they would as files, so the gain is no font swap and less layout shift.

## A. Bytes and rendering

Each variant was served locally and loaded in Chrome at 390 and 1280 px wide, 1× and 2× density, with images hidden and the page painted again before the screenshot. Font bytes are the bodies of font responses; subfont's fonts are inside a stylesheet.

| Variant                                | Font bytes per page                                             | Pixels different from the original (16 comparisons)   |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Original                               | 407 KB                                                          | —                                                     |
| subfont                                | 0 font files; 117 KB of fonts in a stylesheet (88 KB as Brotli) | 12: every page at 1×, and the 10 px text at 390 px 2× |
| fontphobia `auto` (no browser)         | 124 KB                                                          | 0                                                     |
| fontphobia `auto --crawl`              | 91 KB                                                           | 0                                                     |
| fontphobia `audit` and `build --write` | 91 KB                                                           | 0                                                     |

subfont writes only the files it processes to its output directory. The site's script and images were copied in before measuring; without them the menu page lost its filters and its layout changed.

## B. Run time

| Tool                      | 4 pages | 204 pages | Peak memory, 204 pages |
| ------------------------- | ------- | --------- | ---------------------- |
| subfont                   | 2.0 s   | 24.8 s    | 1.17 GB                |
| fontphobia `auto`         | 5.7 s   | 5.9 s     | 0.34 GB                |
| fontphobia `auto --crawl` | 12.8 s  | 291 s     | 0.76 GB                |

- subfont re-runs its CSS cascade for every page (font-tracer on a parsed DOM).
- A CPU profile of fontphobia `auto` on 4 pages put 5.1 s of 5.7 s in WOFF2 compression (wawoff2), which includes the files built only to report what each opt-in would save.
- The crawl visits each page at least nine times: four widths, then the default-font-size sweep at two of them.

## C. How subfont works without a browser

From its source:

- font-tracer applies the page's CSS to a parsed DOM. `@media`, `@supports` and `:hover` are not evaluated: both branches count. Page JavaScript does not run unless `--dynamic` is given, which downloads Chromium and adds what it finds.
- Text is pooled across the site: each font gets one subset.
- The subset becomes a new family, `<Family>__subset`, placed before the original in every `font-family`. The original `@font-face` rules move to a stylesheet that a script loads after the page, with a `<noscript>` copy.
- Subsets go in the stylesheet as `data:` URLs when there is one format and the font is used on every page.
- subset-font is called with its defaults: hinting kept, every OpenType feature kept, glyph names dropped. Variable axes are limited only with `--instance`.
- Nothing checks shaping or rendering.
- Two `@font-face` rules with the same family, weight and style stop the run, so fonts already sliced by `unicode-range` (Google Fonts, Fontsource) are not accepted as input.

## D. `data:` URLs or files

The same four builds were loaded with a cold cache through Chrome's network throttling, text responses Brotli-compressed, at 390 px and 2×. "Final fonts" is the last `loadingdone` event of `document.fonts`, or the first paint when that is later. Medians of 7 runs (5 on the slower link), home and menu pages.

| 1.6 Mbit/s, 150 ms round trip                  | First paint | Final fonts | Layout shift, menu |
| ---------------------------------------------- | ----------- | ----------- | ------------------ |
| Files                                          | 0.40 s      | 1.22–1.45 s | 0.066              |
| Files, with the core files preloaded           | 0.50–0.54 s | 1.06–1.18 s | 0.066              |
| `data:` in a linked stylesheet (`inline-core`) | 1.34–1.35 s | 1.34–1.35 s | 0.041              |
| `data:` (subfont)                              | 1.29–1.30 s | 1.29–1.30 s | 0.103              |

| 700 kbit/s, 300 ms round trip                  | First paint | Final fonts |
| ---------------------------------------------- | ----------- | ----------- |
| Files                                          | 0.78 s      | 2.66–3.70 s |
| Files, with the core files preloaded           | 0.91–0.94 s | 2.32–3.03 s |
| `data:` in a linked stylesheet (`inline-core`) | 2.88–2.94 s | 2.88–2.94 s |
| `data:` (subfont)                              | 2.78–2.80 s | 2.78–2.80 s |

- The stylesheet blocks rendering: with 91 KB of core files in it, nothing paints until it arrives.
- Preloading the core files brought the fonts in sooner and delayed the first paint by about 0.13 s, because they share the link with the stylesheet.
- subfont's higher layout shift on the menu page was not investigated.

## E. `data:` URLs with `font-display: block`

The same comparison with the bakery's two faces changed to `font-display: block`, so a page hides text until its font arrives (up to 3 s). The largest contentful paint on both pages is text.

| 1.6 Mbit/s, 150 ms round trip                  | First paint | Text in its font (LCP) | Layout shift, menu |
| ---------------------------------------------- | ----------- | ---------------------- | ------------------ |
| Files                                          | 0.40 s      | 1.28–1.45 s            | 0.061              |
| `data:` in a linked stylesheet (`inline-core`) | 1.31–1.32 s | 1.31–1.34 s            | 0.039              |

| 700 kbit/s, 300 ms round trip                  | First paint | Text in its font (LCP) |
| ---------------------------------------------- | ----------- | ---------------------- |
| Files                                          | 0.75–0.77 s | 2.81–3.66 s            |
| `data:` in a linked stylesheet (`inline-core`) | 2.87–2.93 s | 2.87–2.94 s            |

With `block`, embedding showed text as soon or sooner and shifted the layout less; only the rest of the page painted later. With `swap` (part D), it took away text that had painted in a fallback font at 0.4 s.

## What came of it

- `auto --allow inline-core` holds at most 96 KB of core files in the stylesheet, counted over every face, smallest first, and at most 16 KB once a face with `font-display` swap, fallback or optional is among them. `inlineCoreMax: { block, swap }` changes the two. It notes a swap face whose core it embeds. (0.6.0 had a 16 KB limit per file.)
- Not done:
  - estimating opt-in savings with the Brotli estimate instead of WOFF2;
  - compressing WOFF2 in worker threads;
  - fewer crawl visits per page (a static pass over every page, the crawl on a sample, the size sweep only where an axis depends on it).

## Limits

- One small site, one machine, simulated throttling, first visits only.
- The rendering differences are macOS-specific; Linux and Windows were not checked.
- Not run: subfont `--dynamic` and `--instance`, the `@turntrout/subfont` fork, glyphhanger.
