# Spike 1: what DOMSnapshot's layout text captures

Chrome 155.0.8059.79, `DOMSnapshot.captureSnapshot` with `documents[].layout.text`, plus `CSS.getPlatformFontsForNode`. Test page: `page.html`. Script: `run.mjs`. Output: `output.txt`.

## Answer

The layout text includes generated text. Collect from `layout.text`, not DOM text nodes.

| Construct | In layout text? | Notes |
|---|---|---|
| `text-transform: uppercase` / `lowercase` / `capitalize` | ✅ transformed | `straße` → `STRASSE`; `İSTANBUL` (`lang=tr`) → `istanbul`; `ǳ` → titlecase `ǲ`; `ǆ` → `Ǆ` |
| `text-transform: full-width` | n/a in Chrome | Chrome 155 computes it as `none`. Firefox and Safari support it, so a Chrome-only crawl would miss U+FF01–FF5E |
| `::before`/`::after`, `content: attr()` | ✅ | Tagged as pseudo-element nodes |
| `<q>` quotes (`lang` en/de/fr, nested), `quotes:` property | ✅ | Locale-correct: `„“ ‚‘`, `« »` |
| `::marker`: disc, decimal with `start`, `lower-greek`, `@counter-style` symbols, `::marker { content }`, `<summary>` | ✅ | Includes the suffix and trailing space: `•␠␠`, `7.␠␠`, `α.␠␠`, `✓␠␠`, `▸␠␠` |
| `counter(c, upper-roman)` | ✅ | `IV`, `V` |
| Shadow DOM, open **and closed** | ✅ | The snapshot pierces closed roots |
| SVG `<text>` | ✅ | |
| `::first-letter` | ✅ | Separate layout node; `getPlatformFontsForNode` reports its own font (Courier New:1) |
| `<button>` | ✅ | |
| `<input>` value, placeholder, password, `type=file`, `type=date` | ❌ | No DOM text and no layout text. The UA shadow tree isn't in the snapshot |
| `<textarea>`, `<select>` options | ❌ in layout | Present as DOM text only |
| `text-overflow: ellipsis` | ❌ | `…` is never in the text. `boxes=1` |
| `hyphens: auto` | ❌ | Lines break (`boxes=5`), but the hyphen glyph isn't in the text |
| `font-variant-caps: small-caps` (synthesized, Georgia) | ❌ | Text stays `Small Caps`. The synthesized uppercase isn't in the text |
| `display: none` | ❌ (expected) | |
| `visibility: hidden` | ✅ | Laid out, so it counts |

`CSS.getPlatformFontsForNode` counts pseudo-element glyphs and shows **system fallback** per node. For example, `→` fell back to Times New Roman, `★` to Songti SC and `✗` to Zapf Dingbats. That's exactly the signal for "the page uses a character the web font doesn't have".

## Implications for the plan

- **§7.3:** read characters from `layout.text`, group them by computed `font-family`/weight/style of the layout node (pseudo-elements included), and ignore DOM `nodeValue`.
- **§7.4 rules confirmed as needed:** ellipsis (U+2026), `hyphens: auto` (U+2010, plus U+002D because Chrome may use either; check the font's `hyph` glyph choice in M2), synthesized small caps (add the uppercase of each lowercase character used with `font-variant-caps` when the font lacks `smcp`/`c2sc`), and form controls.
- **Form controls:** read `value` and `placeholder` from the DOM (`HTMLInputElement.value` via `Runtime.evaluate`), and `<option>` text. For passwords, add U+2022 and U+25CF. Blink masks with `-webkit-text-security: disc`, and engines differ on the bullet code point (not verified per engine here). `type=date`/`time`/`number` render with locale digits and separators: add the CLDR digits and date separators for each audited locale. `type=file` renders a UA string ("Choose File" / "No file chosen"), which is the system font unless the site styles it, so only count it when `::file-selector-button` has a web font.
- **Remove from §7.4:** `<q>` quotes from CLDR `delimiters.json` and counters are already in the layout text for the audited locales. Keep CLDR quotes only as a safety net for locales the crawl didn't visit.
- **New rule:** `text-transform: full-width` and `full-size-kana`. Chrome ignores them, but Firefox and Safari apply them, so map them in the planner.
- **New report item:** per-node system fallback from `getPlatformFontsForNode`. If a character renders in a system font today, the subset can't make it worse, but it's worth reporting.
