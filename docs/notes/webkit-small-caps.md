# WebKit on macOS draws synthesized small caps one pixel differently

**Finding (2026-11-11).** With `verify --browsers webkit` on macOS, the static-css fixture's
`/edge.html` differs from the original fonts by one pixel at DPR 1. At DPR 2 it is identical. Chrome
on macOS is 0 pixels different on the same page.

The text is `<p id="caps" class="caps">small caps</p>`, styled
`font-family: Deja; font-variant-caps: small-caps`. DejaVu Sans has no `smcp` feature, so WebKit
synthesizes the small caps from scaled capitals.

## What is known

- The pixel is at x 57, y 546 in both the 360 px and the 1280 px viewport: an edge pixel between the
  C and the A of "caps".
- The layout is identical. No text box moves or changes size.
- It repeats on every load, in fresh browser sessions. Neither side differs from itself between
  loads, so `verify` reports a regression, not `flaky`.
- Every character of the text is in the face's core file.
- HarfBuzz's subsetter drops two tables from DejaVu Sans: `kern` and `FFTM`. `GPOS` kerning is
  kept. Whether the missing `kern` table matters here hasn't been tested.

## How it was found

`verify` used to call pixelmatch with `includeAA: false`, which skips the pixels it classifies as
anti-aliasing. This pixel was one of them. `verify` now counts every differing pixel
(`diffPixels` in `packages/crawler/src/verify.ts`), and the difference showed up on the first run.

## Not known

The cause. Not tried yet:

- the face built as a single file, to rule out the segmented family;
- an output that keeps the `kern` table (HarfBuzz can't subset it, so this needs retained glyph ids);
- other reference glyphs (see `macos-reference-glyphs.md`).

## What the tests do

`packages/crawler/test/verify.test.ts` masks `#caps` for WebKit on macOS and compares the rest of
the page. Other engines and platforms compare the paragraph.
