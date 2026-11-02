# Spike 9: can a Linux pixel diff detect hinting removal?

Fonts: DejaVu Sans 2.37 and Inter 4.1 hinted Regular, each a Latin subset with and without hinting (`hinting: false` drops `fpgm`/`prep`/`cvt ` and glyph instructions). Text at 10–24 px, DSF 1.

- macOS: Chrome 155.
- Linux: `mcr.microsoft.com/playwright:v1.64.1-noble` (bundled Chromium 156.0.8078.80, arm64).

Scripts: `run.mjs` (pixel diff), `widths.mjs` (layout widths). Screenshots are in `shots/`.

## Answers

1. **Yes. Linux headless Chromium renders hinting by default, and the diff is large.**

   | Environment | DejaVu px changed | Inter px changed |
   |---|---|---|
   | macOS Chrome (control) | 0 | 0 |
   | Linux, default | 19,305 | 23,995 |
   | Linux, `--font-render-hinting=full` | 19,305 | 23,995 (same as default) |
   | Linux, fontconfig `hintnone`/`hintslight`/`hintfull` (autohint off), or `hintfull` + FreeType interpreter v35 | 13,943 | 17,422 (identical across all four) |
   | Linux, `--font-render-hinting=none` | 0 | 0 |

   - **The Chrome flag controls hinting; fontconfig `hintstyle` doesn't.** Headless Chromium ignores fontconfig's hintstyle: all four configs gave identical counts. Setting `FONTCONFIG_FILE` still changed the counts, probably through the antialias/rgba settings in the file. Control it with the Chrome flag, not fontconfig.
   - **The plan was wrong to call for fontconfig `hintfull` with the autohinter off.** Use the default, or `--font-render-hinting=full`.
2. **On Linux at DSF 1, hinting changes layout, not just pixels.** With hinting on, Chromium snaps each advance to a whole pixel, so text widths are integers. Dropping hinting changes line widths by **−40 to +80 px over 460 characters** (0.1–0.2 px per glyph). That's enough to change line breaks on most paragraphs. With `--font-render-hinting=none`, widths are fractional and identical to macOS to the thousandth.
3. **The same rounding amplifies the axis-limiting drift from spike 3.** On Linux, range-limited Inter is mostly identical (0 px), but some coordinates jump by whole pixels: +12 px at 16 px and up to ±60 px at 64 px over 1,032 glyphs. One common glyph's rounded advance flips, and every occurrence of it shifts.
4. **How close is this to Windows? Not measured.** There's no Windows runner here. Windows Chrome uses DirectWrite (ClearType-style), which also runs TrueType instructions but mostly ignores horizontal hinting, while FreeType v40 emulates that mode. The Linux diff shows that hinting is *used*. It doesn't show the Windows *amount*. The exact answer still needs a `windows-latest` run of `run.mjs` and `widths.mjs`.
5. **Real desktop Linux may differ from headless.** Desktop Chrome on Linux takes its hinting and subpixel-positioning defaults from the system (fontconfig/GTK), and headless doesn't. Many distros default to `hintslight`, and Chrome enables subpixel positioning on high-DPI screens. So headless with default flags is the *worst case*: full hinting, integer advances.

## Implications for the plan

- **§8.8:** dropping hinting isn't just a Windows pixel question. On Linux at 1×, Chrome lays text out with hinted, whole-pixel advances, so `--allow drop-hinting` changes line widths, and therefore line breaks, for Linux users. Keep hinting by default, and make the report say "changes text layout on Linux at 1× and rendering on Windows".
- **§10.3 `--hinting`:**
  - drop the fontconfig recipe and run the pinned Playwright Linux image with default flags (or `--font-render-hinting=full`), comparing **layout and pixels**;
  - use `--font-render-hinting=none` to rule hinting out of other diffs;
  - keep `windows-latest` as the exact check.
- **§10.3 generally:** run the browser verify twice: macOS/fractional (or Linux with `--font-render-hinting=none`) for the exact comparison, and Linux 1× with hinting as the worst case for advance rounding. Axis limiting can pass the first and fail the second.
- **§17:** update the hinting risk row with these numbers.
