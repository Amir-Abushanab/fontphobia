# macOS looks up the glyphs named "X" and "o"

**Finding (2026-11-03).** On macOS, Chrome and Safari draw some glyphs differently when the font file
has no glyph named `X` or `o`. Inter's `ă` at 16 px came out 49–102 pixels different from any subset
short of most of the font. The glyphs are found by **glyph name** (the `post` table), not by cmap.

## How it was found

1. **Ruled out the glyph's own data.** HarfBuzz's outline, advance and `gvar` data for `ă` and its
   components were byte-identical in the subset.
2. **Ruled out the usual suspects.** `loca` format, table order and alignment, bounding boxes, `maxp`,
   OS/2 and Chrome's font sanitizer (OTS) made no difference.
3. **Blanked other glyphs inside the original font**, every table otherwise untouched. That
   reproduced it, so the rendering depended on which _other_ glyphs were present.
4. **Delta debugging** shrank the needed set to exactly two glyphs: `X` and `o`. No other pair works
   (`H`, `x`, `O` don't).
5. **Fontsource's latin-ext slice confirmed it.** That slice keeps both glyphs with no character
   mapped to them, so macOS must find them by name. This also explains the earlier finding that
   dropping glyph names (`post` v3) changed rendering: without names, macOS can't find them at all.

## What fontphobia does

Every output file keeps the glyphs named `X` and `o`
(`MACOS_REFERENCE_GLYPHS` in `packages/core/src/plan/hintrefs.ts`):

- kept unmapped through HarfBuzz's glyph-index set (`glyphs` option of `subsetFont`), or
- as reference code points outside the file's `unicode-range` when the source maps them, so text
  never draws them from that file.

Cost: two glyphs per file.

## Evidence

- The one-character repro and the planned fontsource files are 0 pixels different in macOS Chrome.
- The Astro fixture verifies identical in Chrome and WebKit on macOS.
- The framework fixture tests (`packages/crawler/test/sites.test.ts`) compare in the host's Chrome on
  macOS again instead of falling back to the Linux image.

## Caveat

This is what Inter (Latin) needs. Fonts for other scripts may have other reference glyphs on macOS;
`fontphobia verify` on a Mac would show it as a regression if so.
