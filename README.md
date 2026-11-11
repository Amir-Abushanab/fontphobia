# fontphobia

Shrink your site's web fonts without changing how anything renders.

fontphobia crawls your built site in Chrome, records exactly which characters, weights, features and axis values each font draws on each page, and splits every font into a small **core** file, an **extended** file and a lazy **rest** file. Text renders with the same glyphs, hinting, kerning and metrics as before, and `verify` proves it pixel for pixel.

```sh
pnpm dlx fontphobia@0.2.0
```

- **Nothing is written until you confirm.** The default command audits, shows the plan and the diff, and asks.
- **Nothing unseen breaks.** Characters no crawled page uses stay in the rest file, which downloads only if a page needs it.
- **Everything is reversible.** `fontphobia revert` puts the original declarations back, byte for byte.
- **Anything that could change rendering is opt-in** and listed with its measured saving.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Font sources](#font-sources)
- [Opt-ins](#opt-ins)
- [Commands](#commands)
- [Keeping the subsets up to date](#keeping-the-subsets-up-to-date)
- [CI](#ci)
- [Configuration](#configuration)
- [Licenses](#licenses)
- [Limitations](#limitations)
- [Development](#development)

## Requirements

- **Node.js 22 or later.** A TypeScript config file needs Node 22.18 or later.
- **Google Chrome**, installed normally. `audit`, `verify` and `check --url` drive it through Playwright; nothing is downloaded. Set `FONTPHOBIA_CHROME` to use another Chrome or Chromium binary.
- **Optional:** Apple `container`, Docker or Podman, for `verify` in the pinned Linux browsers (`--browsers linux-chromium,linux-firefox,linux-webkit` and `--hinting`).

## Quick start

Run everything from the project root (or pass `--cwd`). (If pnpm refuses a release younger than your `minimumReleaseAge`, run it from outside the project with `--cwd`.)

1. **Audit and plan.**
   ```sh
   pnpm dlx fontphobia@0.2.0
   ```
   fontphobia detects the framework, builds the site if there's no build (or asks if it's stale) in a throwaway copy of the project, so the build can't touch your files, and crawls every page it can find at 4 viewport widths, plus a browser font-size sweep. It then prints each face's size now and after, the saving per page, the opt-ins with their savings, and the exact edits.

2. **Confirm.** fontphobia then:
   - writes the subset files next to the original fonts;
   - replaces each `@font-face` with a marked block of three rules;
   - makes `document.fonts.load(font)` and `document.fonts.check(font)` calls in your code also wait for the browser's own font loads (`document.fonts.ready`, `document.fonts.status`). Code that waits for fonts then still waits for every file the page's text needs, not the core file alone, and nothing extra downloads. It reads TypeScript, JSX/TSX and JavaScript, including `<script>` blocks in `.astro`, `.vue`, `.svelte` and `.html` files, and the change type-checks under strict TypeScript;
   - records what it changed in `.fontphobia/manifest.json`.

   Then it runs `verify`, which rebuilds the site and compares every page before and after. Use `--write` (or `-u`) to skip the question.

3. **Review and commit:**
   - the subset files;
   - the edited CSS;
   - `.fontphobia/manifest.json` (and `.fontphobia/sources/`, if fontphobia copied fonts from Google or a framework).

   Everything else fontphobia writes (the usage data, the report, the cache, the diff images) stays in `.fontphobia/`, which ignores it for you.

4. **Keep it current.** Add `fontphobia check` after your build: as one of the [framework integrations](#keeping-the-subsets-up-to-date), a `postbuild` script, or [in CI](#ci). When content needs a character or weight the subsets don't have, the check fails and prints the command to rerun.

5. **Undo any time:**
   ```sh
   pnpm dlx fontphobia@0.2.0 revert
   ```

## How it works

1. **Audit.** Chrome visits every page and records, per font face:
   - the characters it draws, including text added by CSS (`content`, `text-transform`, list markers, quotes);
   - the OpenType features and axis values in use;
   - the words, for shaping.

   The result goes to `.fontphobia/usage.json`. Reruns revisit only pages whose HTML, CSS or fonts changed.
2. **Plan.** This step is deterministic and needs no browser. Each face is split into three files:
   - **core:** characters used on at least half of the face's pages (`coreThreshold`); it loads like the original did;
   - **extended:** every other character any page uses; it loads only on pages that need one of them;
   - **rest:** everything else in the original font, so content added later still renders; it rarely loads.

   Each rule gets a `unicode-range`, so the browser picks the files. Characters that shape together (ligatures, marks, contextual forms) are kept in the same file, so every word shapes exactly as before.
3. **Build.** HarfBuzz subsets the files to WOFF2. Glyph names, hinting, the `.notdef` outline, every feature CSS can turn on and full variable axes are all kept. The CSS edits and the manifest are written together.
4. **Verify.** This runs in three stages:
   - every output is decoded and validated, and the CSS is checked against the original descriptors;
   - every recorded word is shaped with HarfBuzz from the original and from the split files, and the results must be identical;
   - every page is loaded before and after in the browser, and the layout and pixels are compared.

   Each difference is classified, and a real one fails the run, naming the element where it happened. Diff images go to `.fontphobia/verify/`. Content that changes on its own between loads (script-driven animations, canvases, embeds) can't be compared: hide it with `--mask <selector>`, or skip a page with `--ignore <glob>`.

## Font sources

fontphobia finds where each face comes from and edits it there.

| Source | By default | With opt-ins |
|---|---|---|
| Your own `@font-face` rules (CSS, Sass, Less, and `<style>` in Vue, Svelte and Astro) | Core/extended/rest split, in place | All [opt-ins](#opt-ins) that change the files |
| Fontsource (`@fontsource/*`, `@fontsource-variable/*`) | The package CSS is copied into your project; each slice a page uses is subset, and imports point at the copy | |
| `next/font/local` | One subset file per face (Turbopack can't split a `localFont()` call) | |
| Google Fonts `<link>` or `@import` | Reports what `tighten` would drop | `self-host`: full split from the exact files Google served. `tighten`: shorter URL |
| `next/font/google` | Reports unused weights | `eject`: served from your site, split. `tighten`, `limit-axes` |
| Astro Fonts API | `<Font preload>` preloads only the faces pages use | `eject`, `tighten` |
| `@nuxt/fonts` | Reports unused weights, and families it loads a second time (with the `provider: 'none'` fix) | `eject`, `tighten` |
| Adobe Fonts | Report only: kit settings to change, measured (Adobe's license forbids modifying its files) | `fontphobia apply-kit` removes unused styles |
| Anything else (CSS-in-JS, `new FontFace()`, CMS CSS, computed URLs) | Subsets, plus the block to paste and where | |

`eject` copies what the framework emits: its `@font-face` rules, its fallback faces with their exact metrics, and its class or custom-property rules. The page doesn't change, even while fonts load.

## Opt-ins

Pass with `--allow <name>` (repeatable) or `allow: [...]` in the config. Each is listed in the plan with its measured saving.

| Opt-in | What it does | Why it isn't the default |
|---|---|---|
| `self-host` | Serves Google Fonts from your site, split | Changes where fonts load from |
| `eject` | Serves `next/font/google`, Astro Fonts API and `@nuxt/fonts` families from your site, split | Replaces the framework's font loading in your code |
| `tighten` | Drops families and weights nothing asks for from Google URLs and from `next/font`, Astro and Nuxt font options | A page the audit never saw, or CMS text, could ask for one |
| `limit-axes` | Limits variable axes to the ranges in use, and drops axes every use leaves at the default | Text widths shift up to ~0.02% (whole pixels on Linux at 1×) |
| `drop-hinting` | Removes TrueType hinting | Changes rasterization on Windows, and layout on Linux at 1× |
| `split-shaping` | Lets words that mix core and extended characters split across files | Loses kerning where they meet |
| `drop-hint-refs` | Drops the reference characters FreeType's auto-hinter needs | Extended characters hint differently on Linux and ChromeOS |

Italic styles are never dropped, because browsers italicize `em`, `i`, `cite` and others on their own.

## Commands

Every command takes `--cwd <dir>`, and most take `--json`.

| Command | What it does | Key options |
|---|---|---|
| `fontphobia` | Audit, plan, ask, write, verify | `--write`/`-u`, `--allow`, `--ci` |
| `audit` | Crawl and write `.fontphobia/usage.json` and `report.md` | `--dist`, `--build-cmd`, `--start-cmd` (SSR routes), `--url`, `--pages`, `--ignore`, `--viewports`, `--locales`, `--rebuild`, `--no-cache` |
| `build` | Plan from `usage.json` (no browser). Shows the plan and diff; `--write` applies | `--write`, `--allow`, `--no-remainder` |
| `verify` | Check the files and shaping, then compare every page before and after | `--browsers`, `--dpr`, `--viewports`, `--mask`, `--ignore`, `--timeout`, `--baseline overlay\|worktree`, `--hinting`, `--no-browser` |
| `check` | Are the subsets still up to date? Exits 1 when the site would render differently | `--url` (crawl production), `--mode warn`, `--strict`, `--allow-chars` |
| `revert` | Put everything back from the manifest | `--dry-run`, `--keep-kits` |
| `apply-kit` | Adobe Fonts: remove kit styles nothing uses, through the Typekit API (`TYPEKIT_TOKEN` from fonts.adobe.com/account/tokens) | `--yes`, `--check` |
| `inspect <font>` | A font's tables, axes, features, hinting and sizes | |
| `subset <font>` | Low level: subset one font to WOFF2 | `--unicodes`, `--text`, `--features`, `--axis`, `-o` |

**About `verify`:**
- **Engines:** Chrome by default. `--browsers` adds the following:

  | Value | What it runs |
  |---|---|
  | `firefox`, `webkit` | Playwright's builds, on the host |
  | `linux-chromium`, `linux-firefox`, `linux-webkit` | The pinned Playwright Linux image, run in a container |

  `--hinting` adds the worst case for rounding: Linux Chromium at DPR 1, with hinting on.
- **Baseline:** "before" is the same build with the original fonts swapped back. `--baseline worktree` builds `HEAD` in a temporary git worktree instead; this is the default after `eject` or option narrowing, because those change what the framework builds.

## Keeping the subsets up to date

`check` is static by default: no browser and no network.
- **Errors:** anything that would render differently, such as a source font that changed, an edited block, a new `@font-face`, a feature or axis value the subsets dropped, or a character no file has.
- **Warnings:** characters that would load the rest file. They render correctly but download more; `--strict` fails on them too.

Run it after your build with your framework's hook:

| Framework | Setup |
|---|---|
| Vite (guards only) | `plugins: [fontphobia()]` from `fontphobia/vite`. Keeps the subset files out of asset inlining and warns in dev when text uses a character outside a face's subsets |
| Astro, Starlight | `integrations: [fontphobia()]` from `fontphobia/astro` |
| Nuxt | `modules: ['fontphobia/nuxt']` |
| Next.js | `adapterPath: fileURLToPath(import.meta.resolve('fontphobia/next'))` in `next.config.mjs` |
| React Router | `buildEnd: fontphobia()` from `fontphobia/react-router` in `react-router.config.ts` |
| VitePress | `buildEnd: fontphobia()` from `fontphobia/vitepress` |
| Docusaurus | `plugins: ['fontphobia/docusaurus']` |
| Eleventy | `eleventyConfig.addPlugin(fontphobia)` from `fontphobia/eleventy` |
| Rsbuild | `plugins: [fontphobia()]` from `fontphobia/rsbuild` |
| Rspack, webpack | `plugins: [new FontphobiaPlugin()]` from `fontphobia/rspack` or `fontphobia/webpack` |
| Anything else (SvelteKit, TanStack Start, Angular, Hugo…) | `"postbuild": "fontphobia check"` in `package.json` |

**Setting these up:**
- **Install:** the integrations need fontphobia in the project: `pnpm add -D fontphobia@0.2.0`.
- **Options:** each one takes `{ mode: 'warn' | 'error', strict, allowChars }`. The Next adapter reads them from the config's `check` key instead.
- **What they skip:** none of them subsets anything, opens a browser or touches the network.

## CI

Three recipes; full workflow files are in [docs/ci.md](https://github.com/Amir-Abushanab/fontphobia/blob/main/docs/ci.md).

- **On every pull request:** build the site, then run `pnpm dlx fontphobia@0.2.0 check`.
- **On a schedule, against production:**
  ```sh
  pnpm dlx fontphobia@0.2.0 check --url https://example.com
  ```
  This crawls the live site and compares what it draws with the files. It catches content from a CMS that the repo never sees.
- **Verify on Windows and Linux** when you change fonts. Hinting and rasterization differ by OS, so run `pnpm dlx fontphobia@0.2.0 verify` on `windows-latest`, and add `--hinting` on `ubuntu-latest`.

## Configuration

`fontphobia.config.ts` (also `.mts`, `.mjs`, `.js` or `.json`) is optional. Every key is optional too.

```ts
import { defineConfig } from 'fontphobia'

export default defineConfig({
  dist: 'dist',                            // built site to crawl
  build: 'pnpm build',                     // how to build it
  start: 'node server.js',                 // production server, for SSR routes
  pages: ['/', '/blog/**'],                // added to the pages found automatically
  ignore: ['/admin/**'],
  auth: { storageState: '.auth.json' },    // Playwright storage state, for pages behind a login
  viewports: [360, 768, 1280, 1920],
  locales: ['en', 'fr'],                   // their characters (quotes and so on) go into the subsets
  maxPages: 500,
  coreThreshold: 0.5,                      // share of a face's pages a character needs to be in core
  remainder: true,                         // the lazy rest file
  allow: [],                               // opt-ins
  rename: { 'Source Serif 4': 'SrcSerif Subset' }, // internal name for OFL Reserved Font Names
  licenses: { allow: [] },                 // families you have the rights to modify
  check: { mode: 'error', strict: false, allowChars: '' },
  verify: { browsers: ['chromium'], hinting: false, viewports: [360, 1280], dprs: [1, 2] },
})
```

## Licenses

fontphobia modifies only fonts whose license it recognizes as open:
- SIL OFL and Apache 2.0;
- the Ubuntu Font Licence and the Bitstream Vera license;
- MIT, CC0, and GPL with the font exception.

It reads the license from the font's name table, or from a license file or `package.json` next to the font.

**Refused:**
- other fonts, unless you list the family under `licenses.allow`;
- fonts whose `fsType` forbids subsetting.

**Reserved Font Names:** OFL fonts with a Reserved Font Name get renamed inside the subset files, as the license requires. The CSS `font-family` stays the same, so nothing on the page changes. Use `rename` to choose the name.

**Adobe Fonts:** files are never written to disk, not even for comparisons.

## Limitations

- **Text the crawl can't see** isn't in core or extended: pages behind a login (use `auth`), text added by scripts after load, and content added later. It renders from the rest file. With `remainder: false`, it renders in the next font in the stack.
- **CFF fonts** that need a rename because of an OFL Reserved Font Name aren't supported yet.
- **`apply-kit` publishes your Adobe kit**, which changes every site that uses it. It refuses a kit whose draft has unpublished changes, reads each change back from Adobe and publishes only if it matches, and `revert` restores the previous styles only if nobody edited the kit since (otherwise it says which styles to add back, or `revert --keep-kits` leaves the kit as it is). Another site sharing the kit can run `fontphobia apply-kit --check` to see whether it lost a style it uses. It doesn't change the character set: Adobe's API doesn't reflect the web UI's setting, so the audit report says which one to pick and you change it on fonts.adobe.com.

## Development

```sh
pnpm install
pnpm test                       # unit, golden-hash and crawler tests (crawler tests need Chrome)
pnpm typecheck
pnpm --filter fontphobia build  # bundles packages/cli/dist and the HarfBuzz WASM
node packages/cli/src/cli.ts --help
```

**Fixture sites** have their own lockfiles. Install them, then run their tests with `FONTPHOBIA_SITES=1`. The Google, Next and Astro tests need the network.

```sh
for d in fixtures/sites/{astro,tanstack-start,next,nuxt} fixtures/integrations; do (cd $d && pnpm install); done
FONTPHOBIA_SITES=1 pnpm vitest run packages/crawler/test/sites.test.ts packages/cli/test/integrations.test.ts
pnpm plans:update   # re-crawl the fixtures and rewrite fixtures/plans/*
```

**Layout:**
- `packages/core`: font I/O, subsetting, shaping, the CSS model, planning, build, check. No browser.
- `packages/crawler`: audit and verify, with Chrome through `playwright-core`.
- `packages/cli`: the published `fontphobia` package and the integrations.
- `fixtures/`: test fonts and sites.
- `PLAN.md`: the design and the notes from each milestone.
- `spikes/`: research, not part of the build.

**Releasing:** bump `packages/cli/package.json`, then push a `v<version>` tag. `.github/workflows/release.yml` tests, packs and publishes with npm provenance.

MIT © Amir Abushanab
