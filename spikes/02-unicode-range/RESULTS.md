# Spike 2: Chrome across `unicode-range` files of one family

Chrome 155.0.8059.79, 48 px, DSF 2. Inter 4.1 variable, split three ways:

- **`Whole`**: ASCII + extended in one file, 88.7 KB.
- **`Split`**: core = ASCII (41.0 KB) + ext = Latin-1, Latin Ext-A, combining marks and typographic punctuation (51.6 KB).
- **`SplitM`**: core = ASCII + combining marks (72.5 KB) + ext without marks (38.8 KB).

Same family name, served over HTTP with request logging. Script: `run.mjs`. Output: `output.txt`. Pixel diffs for the non-zero cases: `shots/`.

## Answers

1. **Kerning is lost where the files meet, in both directions, and it's large.**
   - `Tö Vä Yö Wå Tü Fä Pö`: **+18.0 px** wider than `Whole` (about 2.6 px per pair, 0.054 em).
   - `Äv Öy Åw ÜT`: +6.5 px.
   - `“Too” ‘yo’`: +1.9 px (curly quotes in ext, `T` in core).
   - `café naïve`: +0.47 px (`f|é`).

   Pairs within one file are exact (`AVATAR To We Yo`: 0 px diff).
2. **Contextual alternates break too.** In `Ä:Ö`, Inter's `calt` raises the colon between capitals. With the colon in core and the capitals in ext, the colon drops back: widths match but 785 pixels change.
3. **Combining marks: Chrome composes to NFC when the cluster spans files.** `e` + U+0301 with the mark only in ext rendered exactly like precomposed `é` from ext: the same +0.47 px and the same 15-pixel diff from losing the `f|é` kern. With marks in core (`SplitM`), the decomposed text renders **identically to `Whole`** (0 px), and only the core file is fetched.
4. **Downloads match `unicode-range`.** An ASCII-only page fetches only core. One `é` fetches ext. Decomposed `e` + U+0301 fetches ext under `Split` but only core under `SplitM`.

## Implications for the plan

- **§8 cross-file shaping repair is required, not an optimization.** The default split loses kerning on ordinary words in German, Swedish and French (`Tö`, `Vä`, `Fä`), and around curly quotes. The repair pass shapes stored words whole vs segmented by file and moves characters into core until they match. It must cover `calt`/contextual differences, not only advances, so compare glyph IDs and positions.
- **§8 core contents:** this confirms combining marks belong in core (U+0300–036F at least). It also argues that typographic quotes and dashes (U+2018/2019/201C/201D/2013/2014/2026) should be core by default, because they sit next to ASCII letters in almost every language.
- **§8 reporting:** the `split-shaping` opt-in in §3 ("loses kerning in … words") is worth keeping. This spike shows each lost pair costs about 0.05 em, which is a visible change, not sub-pixel.
- **§10.3:** the verifier's layout diff will catch these (box widths change by whole pixels), so a split that skips the repair pass fails `verify`.
