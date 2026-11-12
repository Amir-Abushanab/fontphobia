# Changelog

## Unreleased

### Added

- The package ships TypeScript declarations for `fontphobia` and every `fontphobia/<framework>` entry.
- The package includes `dist/THIRD-PARTY-NOTICES.txt`, with the licenses of the bundled dependencies.
- `fontphobia.config` is validated. An unknown key or a value of the wrong type is an error that names the file and the key.

### Changed

- `check` exits 1 when there is no `.fontphobia/manifest.json` to check against, and `check --url` exits 1 when a page can't be loaded. `--mode warn` reports both without failing. For a missing manifest, the framework integrations log a warning and let the build finish.
- `verify` counts every differing pixel. It used to skip pixels that were classified as anti-aliasing, which hid changes on glyph edges. A difference that shows on one load and not on a reload is reported as `flaky` and doesn't fail the run; Chrome on macOS sometimes draws the corners of form controls this way.
- A font's license is read only from files that belong to the font. The project's own `LICENSE` and `package.json` no longer count.
- The rename for an OFL Reserved Font Name is decided from the font's own family name instead of the CSS `font-family`, so a font declared under another CSS name is renamed too.
- With `dist` and a build command both set, the site is built when the output is missing or stale, or with `--rebuild`. Before, setting `dist` meant the build never ran.
- `build --write` is all or nothing. If a write fails, the files already written are restored.
- A `--cwd` that isn't a directory is an error.

### Fixed

- `audit --url` and `check --url` crawl sites served under a path prefix, such as a GitHub Pages project site. They used to visit only the home page.
- `check --url` uses the config's `pages`, `ignore` and `auth`.
- The framework integrations read `check` settings from a config that imports `defineConfig`. The Astro integration reads the config's `check` key.
- Static `check` decodes every HTML named character reference, leaves out `<title>`, and no longer stops on an out-of-range numeric reference.
- The Adobe Fonts report and `apply-kit --check` read the characters the pages use. They treated the recorded ranges as literal text, so the report always said the pages fit Adobe's Default character set.
- Reserved Font Names written without quotes are recognized.
- A `//` comment inside `@font-face` in a Sass or Less file no longer stops the build.
- `build` matches a face to its `@font-face` rule by descriptors before line number. A face it can't match after the stylesheet changed is reported and left unwritten.
- A face that fails to plan or build is reported and skipped. The other faces are still built.
- The throwaway build copy includes every workspace package's `node_modules`, git submodules, and the build outputs of the workspace packages the project depends on. A project that its repository ignores is copied directly.
- `verify --baseline worktree` accepts fontphobia's own `document.fonts.load` edits, and copies `.env` files into the worktree.
- `subset` accepts text with one half of a mirrored pair, such as `a>b`, and option values that look like numbers, such as `--text 2024`.
- `locales: ['zh-TW']` selects Traditional Chinese characters. `sr-ME` and `pa-PK` select their Latin and Arabic script sets.

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
