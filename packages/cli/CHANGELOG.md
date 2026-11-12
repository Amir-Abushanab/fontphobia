# fontphobia

## 0.2.0

2026-11-10

### Added

- `verify --mask` hides content that changes by itself between loads. `--ignore` skips pages and `--timeout` sets the page load limit. All three are also available in `fontphobia.config` (`verify.mask`, `verify.timeout`, `ignore`).
- Each `verify` example names its element with a CSS selector, so a regression on a large page can be located.

### Changed

- fontphobia keeps its files in `.fontphobia/` and runs builds in a throwaway copy of the project, with dependencies hard-linked.
- `audit` and `verify` reuse the last build in `.fontphobia/output` when it is newer than every source file, instead of rebuilding on each run.
- `check` ignores a `usage.json` that came from another audit. `verify` clears its old diff images.

### Fixed

- Font readiness checks (`document.fonts.load` and `document.fonts.check` in the site's code) wait for the browser's own font loads. Previously the page text was passed in, which fetched extended and rest files the page's fonts do not use.
- Astro builds work in the throwaway copy: dependencies' `.astro` files resolve to their real paths.

## 0.1.1

2026-11-04

### Fixed

- `verify` renders text with grayscale antialiasing and retries failed loads in a fresh browser.

## 0.1.0

2026-11-04

First release.

### Added

- `audit`, `build` (with `--write` and `revert`), `verify` and `check`, which subset fonts and compare rendering against the original.
- Providers and frameworks: Google Fonts (tighten, self-host), Fontsource (eject), manual faces, `next/font/google` and `next/font/local`, Astro fonts, `@nuxt/fonts`, and Adobe Fonts (`apply-kit`, experimental).
- Integrations: `fontphobia/vite`, `astro`, `nuxt`, `react-router`, `vitepress`, `docusaurus`, `eleventy`, `next`, `rsbuild`, `rspack` and `webpack`.
- `check` separates errors from warnings. Only rendering changes fail by default.
- The Adobe Fonts report covers kit bytes per page, unused styles, OpenType features, character set and `font-display`.

### Changed

- Dropping unused Google families and weights, and `next/font` or Astro weights, is reported by default. `--allow tighten` applies it.
- A face is matched to its `@font-face` rule by URL and descriptors, since providers serve one variable file for every weight.
- The glyphs named "X" and "o" are kept in every output because macOS looks them up for rendering.

### Fixed

- `verify` no longer fails on pixel-only differences that appear when the original is compared with itself.
