# Spike 3: what HarfBuzz's subsetter changes besides the glyph set

harfbuzzjs 1.6.4, Chrome 155.0.8059.79 (macOS), Node 24.21.0. Fonts: Inter 4.1 `InterVariable.ttf` (opsz 14–32, wght 100–900, unhinted), Inter 4.1 hinted static Regular, DejaVu Sans 2.37 (hinted). Subset = U+0020–007E + U+00A0–00FF.

## Answers

1. **Plain subsetting with all axes kept is exact.** Glyph outlines, advances, shaping positions and font extents are identical to the original at every coordinate tested, in HarfBuzz and in Chrome (0.000 px width difference over 1,032 glyphs).
2. **Changing the axes is not exact, and the error builds up across a line.**
   - **Range limiting** (`wght 400..700`, or that plus `opsz 14..24`):
     - points move by up to **2.14 font units** (of 2048) and advances by up to 1 unit;
     - the default location stays exact;
     - in Chrome, a 1,032-glyph line ends up **0.4–1.5 px narrower at 16 px** and **1.7–6.2 px narrower at 64 px**;
     - the error is always in the same direction (narrower).
   - **Pinning** to a static instance: points move by up to 0.94 units (rounding to integers). HarfBuzz reports the same advances, but Chrome measures **−0.6 to +3.0 px at 64 px**. A static font stores advances as integers, while Chrome computes fractional advances from the variable original.
   - Dropping `HVAR` after instancing made the error worse (−6 to −8 px at 64 px).
   - **Scale:** about 0.02% of line width, so roughly 0.1 px per 80-character line at 16 px and 0.5 px at 64 px. That's enough to shift anti-aliasing along every line, and to change a line break that fits within half a pixel.
3. **Vertical metrics are untouched.**
   - These never change: `hhea` ascender/descender/lineGap, `OS/2` typo and win metrics, `unitsPerEm`, `fsType`, `head.created`/`modified`.
   - Recomputed:
     - `head` bbox, `hhea` minLSB/minRSB/advanceWidthMax/xMaxExtent and `numberOfHMetrics`;
     - `OS/2` xAvgCharWidth, ulUnicodeRange and usFirst/LastCharIndex.
   - Pinning also applies `MVAR` (sxHeight 1118 → 1097) and sets usWeightClass to the pinned weight.
   - None of these affect CSS line height.
4. **Default name IDs are 0–6, plus the IDs that `fvar`/`STAT` reference** (256+, pruned to the axis values that remain).
   - Dropped by default: 7 trademark, 8 manufacturer, 9 designer, 11/12 URLs, **13 license description, 14 license URL**, 25.
   - Keeping IDs 0–25 costs +92 B (Inter) to +1.5 KB (DejaVu) of WOFF2.
5. **Default layout features are HarfBuzz's list, pruned to what still applies.**
   - Inter Latin keeps only `calt dnom frac locl numr` + `kern`.
   - Dropped and reachable from CSS: `case`, `tnum`, `pnum`, `zero`, `ordn`, `sups`, `subs`, `sinf`, `salt`, `ss01–08`, `cv01–14`, `dlig`, `aalt`.
   - So `font-variant-numeric: tabular-nums` and `font-feature-settings: 'ss01'` stop working unless the planner adds those features.
   - Keeping `*` costs +31 KB WOFF2 on Inter (55 → 86 KB).
   - `mark`/`mkmk`/`ccmp` disappear because there are no combining marks in the subset.
6. **Hinting:** `hinting: false` removes `fpgm`, `prep`, `cvt ` and the glyph instructions.
   - Leaves outlines and advances unchanged.
   - WOFF2 Latin savings: DejaVu 20.3 → 9.3 KB (−54%), Inter hinted 20.5 → 14.3 KB (−30%).
   - The variable Inter has no hinting, so there's no change.
7. **Determinism within a process:** repeated subsets are byte-identical. Across OS and Node versions, see spike 4.

## Bug found: wawoff2 2.0.1 corrupts concurrent calls

`compress()` and `decompress()` resolve with a view into the WASM heap, so overlapping calls overwrite each other's output. In the test, `Promise.all` over three inputs returned two invalid files that Chrome's OTS rejected. Sequential calls are fine. `lib/hb.mjs` now serializes the calls and copies each result. See `../04-wawoff2/concurrency.mjs`.

## Evidence

- `run.mjs` → `output.txt`: per-config outline, advance and shaping deviation, table diffs, name IDs and features.
- `sizes.mjs` → `sizes.txt`: WOFF2 cost of each keep option.
- `drift.mjs` → `drift.txt`: HarfBuzz cumulative advance drift.
- `browser.mjs` → `browser.txt`, `pinned.mjs` → `pinned.txt`: Chrome width deltas.

| WOFF2, Latin subset | default | names 0–25 | features `*` | no hinting | wght 400..700 | pin 400/14 |
|---|---|---|---|---|---|---|
| InterVariable | 54,976 | 55,068 | 86,072 | 54,976 | 38,712 | 14,896 |
| Inter hinted Regular | 20,512 | 20,656 | 31,636 | 14,336 | | |
| DejaVu Sans | 20,344 | 21,888 | 21,588 | 9,296 | | |

## Implications for the plan

- **§8.6 axes:** limiting or pinning an axis is *lossy at the sub-pixel level*, not lossless. Options, recommended first:
  1. Keep it on by default, but have the verifier's layout diff accept horizontal box changes under 1 CSS px only if every line break and every box height is identical. If a line break changes, back off that face to its full axes and report why.
  2. Make axis limiting opt-in (`--allow limit-axes`).

  In either case, §10.3's "sub-pixel rounding" class needs a numeric definition: at most N px horizontal shift per line, no line-break change. The pixel diff will be noisy along every line of instanced text.
- **§8.6 pinning:** when a face uses a few discrete values (e.g. 400 and 700, nothing animated), several pinned static files can beat one range-limited file (2 × 14.9 KB vs 38.7 KB). Add this as a planner candidate, with the same drift caveat.
- **§8 features:** the plan's rule "HarfBuzz defaults + everything CSS enables" is correct, and this spike shows it matters: `tnum`, `case` and `ss**`/`cv**` are not in HarfBuzz's defaults. The CSS→feature map must cover `font-variant-*`, `font-feature-settings`, and `font-variant-alternates`. `text-transform: uppercase` doesn't enable `case`, so it adds nothing here.
- **§11 licensing:** keep name IDs 0–14 and 25 by default, not HarfBuzz's 0–6. The OFL requires the copyright notice and license to travel with each copy, and IDs 13/14 carry them in the binary. It costs about 0.1–1.5 KB.
- **§14 stack:** add the wawoff2 concurrency note. Serialize all calls through one queue in `core`.
- **§16:** spike 3 is answered. Recheck the drift on Linux (FreeType) during spike 9, since the Chrome measurements here are macOS/CoreText.
