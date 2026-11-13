# Spike 10: font-size setting range

Tested 2026-11-02 with Chrome 155.0.8059.79 (headless, macOS). The font is Inter v20 latin with opsz 14..32 (`font/`, OFL).

## Answer

- **Chrome:**
  - Default font size presets are **9 / 12 / 16 / 20 / 24** (Very small → Very large).
  - "Customize fonts" slider: **9–72** (25 ticks).
  - Minimum font size: **0 (off), 6–24**.
- **Firefox:**
  - Default size list: **9–72** (same 25 values as Chrome's slider).
  - Minimum size: **None, 9–72**.
  - `about:config` (`font.size.variable.*`, `font.minimum-size.*`) accepts any integer, which no sweep can bound.
- **Safari (macOS):**
  - no default-size setting;
  - "Never use font sizes smaller than" offers **9, 10, 11, 12, 14, 18, 24** (third-party source, not verified in Safari);
  - also has page zoom and View → Zoom Text Only.
- **CDP `Page.setFontSizes` matches the real pref exactly.** Setting `webkit.webprefs.default_font_size` in a profile gives identical computed sizes and `opsz` at 24 and 9. Values below 9 behaved like 9 (`standard: 6` → `1rem` = 9px), and 100 was accepted.
- **Minimum font size changes `getComputedStyle().fontSize` and layout, but not the `opsz` input.** Chrome computes auto `opsz` from the size _before_ the minimum is applied. It then reuses one value for every run of text that ends up at the same used size, whichever specified size rendered first. At minimum 20, 8px/16px/20px text all get `opsz` 20, 14 or 16 depending only on render order. This is a Chrome bug: output depends on order. It can't introduce an `opsz` value outside the range the page's own specified sizes already produce, so it doesn't widen the axis range the planner keeps. CDP can't set the minimum; it has to go through profile prefs.
- **OS text scale reaches CSS px only on opt-in pages.**
  - `<meta name="text-scale" content="scale">` (Intent to Ship for Chrome 146) multiplies the root font size by the OS text scale, so `rem` and `opsz` follow.
  - Without the meta, the emulated OS scale changed nothing on desktop, including `env(preferred-text-scale)`, which stayed at 1.
  - DevTools' emulation works through CDP `Emulation.setEmulatedOSTextScale`.
  - Android allows up to 200% (Android 14 nonlinear scaling). Windows "Text size" goes up to 225%, from memory and not verified.
  - Chrome Android text autosizing changed in Chrome 141 and is disabled by the meta.
  - iOS Safari's aA text size and Dynamic Type couldn't be tested here (no iOS device or simulator run). Dynamic Type only affects `font: -apple-system-*` keywords.

**Sweep the audit should use (per page, at the narrowest and widest viewport):**

| Setting                            | Values                                                                            | Why                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Default font size (CDP `standard`) | **9, 16, 72**                                                                     | 9 and 72 bound Chrome and Firefox UI settings. Size → `opsz` is monotone, so the extremes bound the axis                     |
| Extra presets                      | 12, 20, 24                                                                        | Only when the site has `em`/`rem` media queries, since content can change at those sizes. These add coverage, not axis range |
| OS text scale                      | **0.85 and 2.0** at default 16, only when the page has `<meta name="text-scale">` | Opt-in pages only. The lower bound reaches fonts whose `opsz` min is below 9 (Roboto Flex: 8)                                |
| Minimum font size                  | none                                                                              | Can't widen the `opsz` range (see above). Mention it in the verify report as a known Chrome order-dependence                 |

## Evidence

### Chromium source (main, fetched 2026-11-02)

- `chrome/browser/resources/settings/appearance_page/appearance_page.ts` has `fontSizeOptions_`: 9 verySmall, 12 small, 16 medium, 20 large, 24 veryLarge, and `SIZE_DIFFERENCE_FIXED_STANDARD = 3` (monospace = standard − 3). https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/resources/settings/appearance_page/appearance_page.ts
- `chrome/browser/resources/settings/appearance_page/appearance_fonts_page.ts`:
  - `FONT_SIZE_RANGE = [9,10,11,12,13,14,15,16,17,18,20,22,24,26,28,30,32,34,36,40,44,48,56,64,72]`;
  - `MINIMUM_FONT_SIZE_RANGE = [0,6,7,8,9,10,11,12,13,14,15,16,17,18,20,22,24]`.

  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/resources/settings/appearance_page/appearance_fonts_page.ts

### Firefox source (mozilla-firefox/firefox main)

- `browser/components/preferences/config/accessibility.mjs` has `fontSizeOptions` 9…72, the same 25 values. https://github.com/mozilla-firefox/firefox/blob/main/browser/components/preferences/config/accessibility.mjs
- `browser/components/preferences/dialogs/fonts.xhtml` has the minimum-size menulist: 0 (None), then 9…72. https://github.com/mozilla-firefox/firefox/blob/main/browser/components/preferences/dialogs/fonts.xhtml

### Safari, mobile and OS text scale

- **Safari minimum-size list:** https://bugzilla.mozilla.org/show_bug.cgi?id=1202922
- **`meta name="text-scale"`:** Intent to Ship, M146, all Blink platforms, 3 LGTMs. https://groups.google.com/a/chromium.org/g/blink-dev/c/0yp2ygJK5HE
- **Intent to Prototype:** https://groups.google.com/a/chromium.org/g/blink-dev/c/2F5g2dqy9_Q
- **Chrome 141 autosizing change and the `env(preferred-text-scale)` workaround:** https://phabricator.wikimedia.org/T407447
- **Android 14 font scaling up to 200%:** https://developer.android.com/about/versions/14/features

### Measurements

All raw numbers are in `results.json`, `results-minimum.json`, `order-dependence.txt` and `os-text-scale.txt`.

`sizes.mjs`, part A (CDP default size → computed / auto `opsz`):

| standard | `1rem`    | `0.75rem`   | `small`        | `16px`    |
| -------- | --------- | ----------- | -------------- | --------- |
| 9        | 9px / 14  | 6.75px / 14 | 9px / 14       | 16px / 16 |
| 16       | 16px / 16 | 12px / 14   | 13px / 14      | 16px / 16 |
| 24       | 24px / 24 | 18px / 18   | 21.36px / 21.5 | 16px / 16 |
| 72       | 72px / 32 | 54px / 32   | 64.08px / 32   | 16px / 16 |

The `small` keyword doesn't scale linearly. It follows Blink's keyword table, so `opsz` depends on keyword sizes as well as `rem`.

`order-dependence.mjs` (minimum 20, default 16, fresh profile per order):

```
order 20px,16px,8px:   20px→opsz 20  16px→opsz 20  8px→opsz 20
order 8px,20px,16px:   8px→opsz 14   20px→opsz 14  16px→opsz 14
order 16px,8px,20px:   16px→opsz 16  8px→opsz 16   20px→opsz 16
```

`os-text-scale.mjs`:

```
no meta          os scale 1.5   rem=16px px=16px envProbe=16px root=16px
meta text-scale  os scale 1.5   rem=24px px=16px envProbe=24px root=24px
meta text-scale  os scale 2     rem=32px px=16px envProbe=32px root=32px
```

To reproduce: `pnpm install && node sizes.mjs && node minimum-opsz.mjs && node order-dependence.mjs && node os-text-scale.mjs`.

## Implications for the plan

- **§7.2 "Default font size sweep":**
  - replace "Chrome's presets plus its custom min and max (confirmed in M0)" with `standard` ∈ {9, 16, 72} at both viewport extremes;
  - add {12, 20, 24} only when `em`/`rem` media queries are present;
  - add OS text scale {0.85, 2.0} via `Emulation.setEmulatedOSTextScale` only when the page has `<meta name="text-scale">`.
- **§8.6:** the `opsz` range is the hull of the swept values. Note that the minimum font size can't widen it, because Chrome feeds the pre-minimum size into `opsz`.
- **§10.3 verify:**
  - pin verify runs to a profile with `minimum_font_size: 0`. Chrome's per-used-size `opsz` reuse makes renders depend on order when a minimum is set, so that would be a source of false differences;
  - record "minimum font size: order-dependent `opsz` in Chrome" under known browser behavior.
- **§17 risks:**
  - `about:config` and Preferences-file values outside 9–72 are unbounded and out of scope; say so;
  - iOS Safari text size / Dynamic Type is untested. Add to "Later" as a WebKit check on a macOS runner (`safaridriver`) or an iOS simulator.
- **§16:** mark spike 10 answered.
