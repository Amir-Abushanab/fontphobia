<h1><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Amir-Abushanab/fontphobia/main/site/assets/logo-dark.svg"><img src="https://raw.githubusercontent.com/Amir-Abushanab/fontphobia/main/site/assets/logo-light.svg" alt="fontphobia" width="340"></picture></h1>

Shrink your site's web fonts without changing how anything renders.

**[Read the walkthrough](https://amir-abushanab.github.io/fontphobia/)**: fontphobia on a real site, step by step, with its actual output.

Browse the example site with [original fonts](https://amir-abushanab.github.io/fontphobia/bakery/before/) or [optimized fonts](https://amir-abushanab.github.io/fontphobia/bakery/after/). Both versions have the same photos, menu filters and content; the walkthrough reports font savings separately from total resource savings.

fontphobia crawls your built site in Chrome, records exactly which characters, weights, features and axis values each font draws on each page, and splits every font into a small **core** file, an **extended** file and a lazy **rest** file. Text renders with the same glyphs, hinting, kerning and metrics as before, and `verify` proves it pixel for pixel.

The W3C's [Incremental Font Transfer](https://www.w3.org/TR/IFT/) proposal has the same aim: a page downloads only the part of a font its text needs. No browser ships it yet. fontphobia is the stopgap: it gets there with `unicode-range`, which every browser supports today.

```sh
pnpm dlx fontphobia@0.6.0
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
- [Auto mode](#auto-mode)
- [CI](#ci)
- [Configuration](#configuration)
- [Licenses](#licenses)
- [Limitations](#limitations)
- [Other tools](#other-tools)
- [Development](#development)
- [Credits](#credits)

## Requirements

- **Node.js 22 or later.** A TypeScript config file needs Node 22.18 or later.
- **Google Chrome**, installed normally. `audit`, `verify` and `check --url` drive it through Playwright; nothing is downloaded. Set `FONTPHOBIA_CHROME` to use another Chrome or Chromium binary.
- **Optional:** Apple `container`, Docker or Podman, for `verify` in the pinned Linux browsers (`--browsers linux-chromium,linux-firefox,linux-webkit` and `--hinting`).

## Quick start

Run everything from the project root (or pass `--cwd`). (If pnpm refuses a release younger than your `minimumReleaseAge`, run it from outside the project with `--cwd`.)

1. **Audit and plan.**

   ```sh
   pnpm dlx fontphobia@0.6.0
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
   pnpm dlx fontphobia@0.6.0 revert
   ```

## How it works

1. **Audit.** Chrome visits every page and records, per font face:
   - the characters it draws, including text added by CSS (`content`, `text-transform`, list markers, quotes);
   - the OpenType features and axis values in use;
   - the words, for shaping.

   The result goes to `.fontphobia/usage.json`. Reruns revisit only pages whose HTML, CSS or fonts changed.

2. **Plan.** This step is deterministic and needs no browser. Each face is split into three files:
   - **core:** printable ASCII and common punctuation, plus the characters your pages use that cost less here than in the extended file; it loads like the original did;
   - **extended:** the Latin and locale characters no page uses yet, and the used characters that cost less here; it loads only on pages that need one of them;
   - **rest:** everything else in the original font, so content added later still renders; it rarely loads.

   Where a used character costs less is measured. In core it adds its own bytes to every page that uses the font. In the extended file it adds that whole file to each page that uses the character. fontphobia builds the candidate splits and keeps the one where the font's pages download the least in total. A few accented letters that one page uses go in core. The alphabet of a page in another script stays in the extended file when several other pages would each have to carry it. To use a fixed rule instead, set `coreThreshold` (or pass `--core-threshold`) to a number from 0 to 1: a character then goes in core when at least that share of the font's pages use it.

   Each rule gets a `unicode-range`, so the browser picks the files. Characters that shape together (ligatures, marks, contextual forms) are kept in the same file, so every word shapes exactly as before.

3. **Build.** HarfBuzz subsets the files to WOFF2. Glyph names, hinting, the `.notdef` outline, every feature CSS can turn on and full variable axes are all kept. The CSS edits and the manifest are written together.
4. **Verify.** This runs in three stages:
   - every output is decoded and validated, and the CSS is checked against the original descriptors;
   - every recorded word is shaped with HarfBuzz from the original and from the split files, and the results must be identical;
   - every page is loaded before and after in the browser, and the layout and pixels are compared.

   Each difference is classified, and a real one fails the run, naming the element where it happened. A pixel difference at unchanged layout counts when loading both sides again repeats it. Chrome rasterizes on the CPU during `verify`, because its GPU rasterizer does not draw every load alike. Diff images go to `.fontphobia/verify/`. Content that changes on its own between loads (script-driven animations, canvases, embeds) can't be compared: hide it with `--mask <selector>`, or skip a page with `--ignore <glob>`.

## Font sources

fontphobia finds where each face comes from and edits it there.

| Source                                                                                | By default                                                                                                   | With opt-ins                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Your own `@font-face` rules (CSS, Sass, Less, and `<style>` in Vue, Svelte and Astro) | Core/extended/rest split, in place                                                                           | All [opt-ins](#opt-ins) that change the files                                      |
| Fontsource (`@fontsource/*`, `@fontsource-variable/*`)                                | The package CSS is copied into your project; each slice a page uses is subset, and imports point at the copy |                                                                                    |
| `next/font/local`                                                                     | One subset file per face (Turbopack can't split a `localFont()` call)                                        |                                                                                    |
| Google Fonts `<link>` or `@import`                                                    | Reports what `tighten` would drop                                                                            | `self-host`: full split from the exact files Google served. `tighten`: shorter URL |
| `next/font/google`                                                                    | Reports unused weights                                                                                       | `eject`: served from your site, split. `tighten`, `limit-axes`                     |
| Astro Fonts API                                                                       | `<Font preload>` preloads only the faces pages use                                                           | `eject`, `tighten`                                                                 |
| `@nuxt/fonts`                                                                         | Reports unused weights, and families it loads a second time (with the `provider: 'none'` fix)                | `eject`, `tighten`                                                                 |
| Adobe Fonts                                                                           | Report only: kit settings to change, measured (Adobe's license forbids modifying its files)                  | `fontphobia apply-kit` removes unused styles                                       |
| Anything else (CSS-in-JS, `new FontFace()`, CMS CSS, computed URLs)                   | Subsets, plus the block to paste and where                                                                   |                                                                                    |

`eject` copies what the framework emits: its `@font-face` rules, its fallback faces with their exact metrics, and its class or custom-property rules. The page doesn't change, even while fonts load.

## Opt-ins

Pass with `--allow <name>` (repeatable) or `allow: [...]` in the config. Each is listed in the plan with its measured saving.

| Opt-in              | What it does                                                                                                   | Why it isn't the default                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `self-host`         | Serves Google Fonts from your site, split                                                                      | Changes where fonts load from                                                                  |
| `eject`             | Serves `next/font/google`, Astro Fonts API and `@nuxt/fonts` families from your site, split                    | Replaces the framework's font loading in your code                                             |
| `tighten`           | Drops families and weights nothing asks for from Google URLs and from `next/font`, Astro and Nuxt font options | A page the audit never saw, or CMS text, could ask for one                                     |
| `limit-axes`        | Limits variable axes to the ranges in use, and drops axes every use leaves at the default                      | Text widths shift up to ~0.02% (whole pixels on Linux at 1×)                                   |
| `drop-hinting`      | Removes TrueType hinting                                                                                       | Changes rasterization on Windows, and layout on Linux at 1×                                    |
| `split-shaping`     | Lets words that mix core and extended characters split across files                                            | Loses kerning where they meet                                                                  |
| `add-preloads`      | With `auto --crawl`: preloads the core file of each face a page draws, where the page has no preload of it     | Changes what the page loads first                                                              |
| `prefetch-extended` | With `auto --crawl`: pages prefetch, when idle, the extended files other pages need and they don't             | Every visitor downloads those files once                                                       |
| `inline-core`       | With `auto --rules linked`: the core file of a face every page draws goes in the stylesheet as a `data:` URL   | Every page's first paint waits for it; capped at 96 KB in all, 16 KB with `font-display: swap` |
| `drop-hint-refs`    | Drops the reference characters FreeType's auto-hinter needs                                                    | Extended characters hint differently on Linux and ChromeOS                                     |

Italic styles are never dropped, because browsers italicize `em`, `i`, `cite` and others on their own.

## Commands

Every command except `inspect` and `subset` takes `--cwd <dir>`, and most take `--json`.

| Command          | What it does                                                                                                                | Key options                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fontphobia`     | Audit, plan, ask, write, verify                                                                                             | `--write`/`-u`, `--allow`, `--ci`                                                                                                          |
| `audit`          | Crawl and write `.fontphobia/usage.json` and `report.md`                                                                    | `--dist`, `--build-cmd`, `--start-cmd` (SSR routes), `--url`, `--pages`, `--ignore`, `--viewports`, `--locales`, `--rebuild`, `--no-cache` |
| `build`          | Plan from `usage.json` (no browser). Shows the plan and diff; `--write` applies                                             | `--write`, `--allow`, `--core-threshold`, `--no-remainder`                                                                                 |
| `verify`         | Check the files and shaping, then compare every page before and after                                                       | `--browsers`, `--dpr`, `--viewports`, `--mask`, `--ignore`, `--timeout`, `--baseline overlay\|worktree`, `--hinting`, `--no-browser`       |
| `check`          | Are the subsets still up to date? Exits 1 when the site would render differently, or when there was nothing to check        | `--url` (crawl production), `--mode warn`, `--strict`, `--allow-chars`                                                                     |
| `auto`           | Subset the built output in place: no source edits and nothing to commit. Run it after every build ([Auto mode](#auto-mode)) | `--dist`, `--crawl`, `--rules`, `--verify`, `--dry-run`, `--allow`, `--core-threshold`, `--no-remainder`                                   |
| `revert`         | Put everything back from the manifest                                                                                       | `--dry-run`, `--keep-kits`                                                                                                                 |
| `apply-kit`      | Adobe Fonts: remove kit styles nothing uses, through the Typekit API (`TYPEKIT_TOKEN` from fonts.adobe.com/account/tokens)  | `--yes`, `--check`                                                                                                                         |
| `inspect <font>` | A font's tables, axes, features, hinting and sizes                                                                          |                                                                                                                                            |
| `subset <font>`  | Low level: subset one font to WOFF2                                                                                         | `--unicodes`, `--text`, `--features`, `--axis`, `-o`                                                                                       |

**About `verify`:**

- **Engines:** Chrome by default. `--browsers` adds the following:

  | Value                                             | What it runs                                          |
  | ------------------------------------------------- | ----------------------------------------------------- |
  | `firefox`, `webkit`                               | Playwright's builds, on the host                      |
  | `linux-chromium`, `linux-firefox`, `linux-webkit` | The pinned Playwright Linux image, run in a container |

  `--hinting` adds the worst case for rounding: Linux Chromium at DPR 1, with hinting on.

- **Baseline:** "before" is the same build with the original fonts swapped back. `--baseline worktree` builds `HEAD` in a temporary git worktree instead; this is the default after `eject` or option narrowing, because those change what the framework builds.

## Keeping the subsets up to date

`check` is static by default: no browser and no network.

- **Errors:** anything that would render differently, such as a source font that changed, an edited block, a new `@font-face`, a feature or axis value the subsets dropped, or a character no file has.
- **Warnings:** characters that would load the rest file. They render correctly but download more; `--strict` fails on them too.
- **Nothing to check:** with no `.fontphobia/manifest.json`, or when `check --url` can't load a page, `check` exits 1, because it confirmed nothing. `--mode warn` reports this without failing. With no manifest, the framework integrations log a warning and let the build finish.

Run it after your build with your framework's hook:

| Framework                                                 | Setup                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite (guards only)                                        | `plugins: [fontphobia()]` from `fontphobia/vite`. Keeps the subset files out of asset inlining and warns in dev when text uses a character outside a face's subsets |
| Astro, Starlight                                          | `integrations: [fontphobia()]` from `fontphobia/astro`                                                                                                              |
| Nuxt                                                      | `modules: ['fontphobia/nuxt']`                                                                                                                                      |
| Next.js                                                   | `adapterPath: fileURLToPath(import.meta.resolve('fontphobia/next'))` in `next.config.mjs`                                                                           |
| React Router                                              | `buildEnd: fontphobia()` from `fontphobia/react-router` in `react-router.config.ts`                                                                                 |
| VitePress                                                 | `buildEnd: fontphobia()` from `fontphobia/vitepress`                                                                                                                |
| Docusaurus                                                | `plugins: ['fontphobia/docusaurus']`                                                                                                                                |
| Eleventy                                                  | `eleventyConfig.addPlugin(fontphobia)` from `fontphobia/eleventy`                                                                                                   |
| Rsbuild                                                   | `plugins: [fontphobia()]` from `fontphobia/rsbuild`                                                                                                                 |
| Rspack, webpack                                           | `plugins: [new FontphobiaPlugin()]` from `fontphobia/rspack` or `fontphobia/webpack`                                                                                |
| Anything else (SvelteKit, TanStack Start, Angular, Hugo…) | `"postbuild": "fontphobia check"` in `package.json`                                                                                                                 |

**Setting these up:**

- **Install:** the integrations need fontphobia in the project: `pnpm add -D fontphobia@0.6.0`.
- **Options:** each one takes `{ mode: 'warn' | 'error', strict, allowChars }`. The Next adapter reads them from the config's `check` key instead.
- **What they skip:** none of them subsets anything, opens a browser or touches the network, unless `auto` is set ([Auto mode](#auto-mode)).

## Auto mode

`fontphobia auto` subsets the fonts of a built site inside its output directory. It edits no source file, writes no manifest and leaves nothing to commit. The output is subset again on every build, so `check` and `revert` are not needed.

```sh
pnpm build && pnpm dlx fontphobia@0.6.0 auto
```

It learns what the site uses in one of two ways:

|                                               | `auto` (static)                                           | `auto --crawl`                                 |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| Chrome                                        | Not needed                                                | Needed wherever the build runs                 |
| Where usage comes from                        | The text of the built HTML and the strings in its scripts | A crawl of the output, the way `audit` does it |
| Which face gets a character                   | Every face of a family the output names that can draw it  | The face that draws it                         |
| OpenType features kept                        | All of the font's                                         | The ones the pages turn on                     |
| Text that CSS generates (counters, `content`) | Not seen; it renders from the extended or rest file       | Counted                                        |
| File sizes                                    | Larger                                                    | The same files the default flow writes         |

On this repository's test site, Inter's 859 KB file becomes a core file of 85.7 KB with `auto` and 55.6 KB with `auto --crawl`.

**What it writes**, all inside the output directory:

- the core, extended and rest files, next to each font;
- the split `@font-face` rules, in a `<style>` at the end of each page's `<head>`. Rules declared later are checked first, so the split files draw the text;
- a `unicode-range` on each original `@font-face` rule, listing the font's own characters. The original rule stays as the fallback for a page without the split rules, such as a server-rendered route. On a page that has them, the original font never downloads;
- a face that only a page's own `<style>` declares, replaced there;
- font preloads, pointed at the core file. This includes the preload hints Next.js puts in its page payloads.

A page that has no preload gets none by default, because a preload changes what the page loads first. `auto --crawl --allow add-preloads` adds one for the core file of each face the page draws. It needs the crawl: the static mode can't tell which faces a page draws, and a preload of a font the page never draws is a wasted download.

Two more opt-ins trade bytes for requests:

- **`--allow prefetch-extended`** (with `--crawl`) adds a `<link rel="prefetch">` of an extended file to the pages that don't need it, when some other page does. The browser fetches it when idle, so a visitor who goes on to a page that needs it finds it cached. Every visitor then downloads the file once. `verify`'s bytes per page don't count a prefetch; the `auto` report gives its size. Safari ignores `rel="prefetch"`.
- **`--allow inline-core`** (with `--rules linked`) puts the core file of a face every page draws into the linked stylesheet as a `data:` URL, which saves its request. The stylesheet blocks rendering, so nothing paints until it arrives. What that costs depends on the face's `font-display` ([spike 13](spikes/13-other-tools/RESULTS.md), 91 KB of core files, 1.6 Mbit/s):
  - `block` (and `auto`, the default): text was hidden until the font arrived anyway. Embedded, it showed as soon or sooner, with less layout shift; only the rest of the page painted later.
  - `swap`, `fallback` or `optional`: pages painted text in a fallback font at 0.4 s. Embedded, they painted nothing until 1.3 s.

  So the stylesheet holds at most 96 KB of core files, counted over every face, smallest first, and at most 16 KB once one of them has `swap`, `fallback` or `optional`. A core that doesn't fit stays a file, and the report says why. `inlineCoreMax: { block, swap }` (bytes) changes the two; a number sets both. A face whose source font a page preloads stays a file too, and the report notes a `swap` face it embeds. `verify` counts the embedded bytes in each page's total. A `Content-Security-Policy` with `font-src` has to allow `data:`.

The split rules go in the HTML for two reasons. A hashed stylesheet keeps its file name when only the site's text changes, so writing the rules into it would let a browser holding the old copy ask for font files the new deploy no longer has. HTML is fetched fresh, so a page and its font rules always come from the same build. And a separate linked stylesheet can arrive after the page's own: in that gap the original rules are the last ones declared, and a style calculation there starts downloading the original fonts. In Chrome with slowed stylesheets that happened in 23 of 480 loads with a linked stylesheet and in none of 576 with the rules inline.

**To use a linked stylesheet instead,** pass `--rules linked` or set `autoRules: 'linked'` in the config. The rules then go in one file, `fontphobia.<hash>.css`, at the output's root, linked last in each page.

|                                                 | `inline` (default)            | `linked`                                                        |
| ----------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| Cost per page view                              | The rules, in the HTML        | Nothing after the first visit: the file is cached               |
| Extra request                                   | None                          | One, on a first visit and after a deploy that changes the rules |
| The original font downloading anyway            | Never seen                    | Now and then, in the gap described above                        |
| A Content-Security-Policy with no inline styles | The browser ignores the rules | Works                                                           |

**A font that would not get smaller is left alone.** For each font, `auto` adds up what its pages would download from the split files, plus the rules in each page's HTML, and compares that with the one file they download now. A font already cut small, such as a Google or Fontsource slice whose pages use most of it, is skipped with that reason. When the total drops but some page downloads more, a note names the pages.

**Checks on every run**, without a browser: each written file decodes and is validated against its source font, the rules keep the original descriptors, and every word found shapes the same from the split files as from the source (outlines, advances and positions). These are the first two stages of `verify`. If one fails, the output is put back as it was and the command exits 1.

**The pixel comparison** needs Chrome, so it is a flag: `fontphobia auto --verify` loads each page before and after and compares layout and pixels, as `verify` does. The checks on every run compare glyphs and positions directly, and those are what change with the site's text. The browser comparison covers how a browser handles the rules and the files, which depends on the fonts and the fontphobia version. Run it when adopting auto mode, after changing a font or upgrading fontphobia, or in CI. It also reports an original font that a page still downloads next to its split files.

**With a framework integration:** each integration's options take `auto`, which replaces the post-build `check`:

```js
fontphobia({ auto: true }); // static
fontphobia({ auto: 'crawl' }); // Chrome
```

The config's `auto` key does the same for every integration that isn't given the option. The Next adapter takes no options, so it reads this key:

```ts
export default defineConfig({ auto: true });
```

Both modes were run with `--verify` on real builds of Astro (Fontsource), Nuxt (`@nuxt/fonts`), Next.js (`next/font/local`, static export) and TanStack Start: every comparison was identical.

**Limits of auto mode:**

- **Static output only.** It needs prerendered HTML. A page rendered by a server does not have the split rules and keeps loading the original fonts.
- **The rules add to each page's HTML:** 0.6 KB and 1.4 KB compressed per page on two test sites (six faces and two). A `Content-Security-Policy` that forbids inline styles makes the browser ignore them, and the original fonts load; `auto` adds a note when a page sets one in a `<meta>` tag. Use `--rules linked` on such a site.
- **Faces it leaves alone:** fonts another origin serves (a Google Fonts link, an Adobe kit), rules inside `@media` or `@supports`, rules a script declares, families nothing in the output names, and fonts the [license rules](#licenses) refuse. Each is listed in the report with the reason.
- **Opt-ins:** `limit-axes`, `self-host`, `eject` and `tighten` are not applied. They change a face's descriptors or where it is served from.
- **Scripts are not rewritten.** A `document.fonts.load()` call waits for the core file only. A script that loads a font file by its URL (`new FontFace(...)`) still downloads the original; `--verify` reports it.
- **A stylesheet loaded with an `integrity` hash is not edited.** Its faces are still split, but a character none of a font's files has makes the original font download.
- **A project with committed subsets is refused.** Run `fontphobia revert` first to switch.
- **Build time and size:** planning and compressing takes a few seconds per face on every build, and the original fonts stay in the output next to the split files.

## CI

Three recipes; full workflow files are in [docs/ci.md](https://github.com/Amir-Abushanab/fontphobia/blob/main/docs/ci.md).

- **On every pull request:** build the site, then run `pnpm dlx fontphobia@0.6.0 check`.
- **On a schedule, against production:**
  ```sh
  pnpm dlx fontphobia@0.6.0 check --url https://example.com
  ```
  This crawls the live site and compares what it draws with the files. It catches content from a CMS that the repo never sees.
- **Auto mode:** run `pnpm dlx fontphobia@0.6.0 auto` after the build step, and add `--verify` in a job that has Chrome.
- **Verify on Windows and Linux** when you change fonts. Hinting and rasterization differ by OS, so run `pnpm dlx fontphobia@0.6.0 verify` on `windows-latest`, and add `--hinting` on `ubuntu-latest`.

## Configuration

`fontphobia.config.ts` (also `.mts`, `.mjs`, `.js` or `.json`) is optional. Every key is optional too. An unknown key or a value of the wrong type is an error that names the file and the key.

```ts
import { defineConfig } from 'fontphobia';

export default defineConfig({
  dist: 'dist', // built site to crawl
  build: 'pnpm build', // how to build it
  start: 'node server.js', // production server, for SSR routes
  pages: ['/', '/blog/**'], // added to the pages found automatically
  ignore: ['/admin/**'],
  auth: { storageState: '.auth.json' }, // Playwright storage state, for pages behind a login
  viewports: [360, 768, 1280, 1920],
  locales: ['en', 'fr'], // their characters (quotes and so on) go into the subsets
  maxPages: 500,
  coreThreshold: 'auto', // which used characters go in core: 'auto' measures; 0 to 1 is a fixed share of a face's pages
  remainder: true, // the lazy rest file
  allow: [], // opt-ins
  rename: { 'Source Serif 4': 'SrcSerif Subset' }, // internal name for OFL Reserved Font Names
  licenses: { allow: [] }, // families you have the rights to modify
  check: { mode: 'error', strict: false, allowChars: '' },
  auto: false, // integrations subset the build output instead of running check: true, 'static' or 'crawl'
  autoRules: 'inline', // where auto puts the split rules: 'inline' (each page) or 'linked' (one cached stylesheet)
  inlineCoreMax: { block: 98304, swap: 16384 }, // auto --allow inline-core: bytes of core files the stylesheet may hold
  verify: { browsers: ['chromium'], hinting: false, viewports: [360, 1280], dprs: [1, 2] },
});
```

## Licenses

fontphobia modifies only fonts whose license it recognizes as open:

- SIL OFL and Apache 2.0;
- the Ubuntu Font Licence and the Bitstream Vera license;
- MIT, CC0, and GPL with the font exception.

It reads the license from the font's name table, or from a license file that belongs to the font:

- a file next to the font, or in a folder above it inside the project (`OFL.txt`, `LICENSE`, or `<Family>-LICENSE.txt` when the family matches);
- for a font in `node_modules`, its package's license file or `package.json` license.

The project's own `LICENSE` and `package.json` never count as a font's license. At the project root, only a file named for the font or for the OFL does.

**Refused:**

- other fonts, unless you list the family under `licenses.allow`;
- fonts whose `fsType` forbids subsetting.

**Reserved Font Names:** OFL fonts with a Reserved Font Name get renamed inside the subset files, as the license requires. The CSS `font-family` stays the same, so nothing on the page changes. Use `rename` to choose the name.

**Adobe Fonts:** files are never written to disk, not even for comparisons.

## Limitations

- **Text the crawl can't see** isn't counted when the files are planned: pages behind a login (use `auth`), text added by scripts after load, and content added later. Its characters render from the extended file when they are in Latin-1, Latin Extended-A or the alphabets of your `locales`, and from the rest file otherwise. With `remainder: false`, what would come from the rest file renders in the next font in the stack.
- **`apply-kit` publishes your Adobe kit**, which changes every site that uses it. It refuses a kit whose draft has unpublished changes, reads each change back from Adobe and publishes only if it matches, and `revert` restores the previous styles only if nobody edited the kit since (otherwise it says which styles to add back, or `revert --keep-kits` leaves the kit as it is). Another site sharing the kit can run `fontphobia apply-kit --check` to see whether it lost a style it uses. It doesn't change the character set: Adobe's API doesn't reflect the web UI's setting, so the audit report says which one to pick and you change it on fonts.adobe.com.

## Other tools

Checked in November 2026, from each tool's README or source. The bytes and rendering of fontphobia and subfont on this repository's example site are measured in [spike 13](spikes/13-other-tools/RESULTS.md).

| Tool (version checked)                                                                                                                                | What it keeps                                                                                                | CSS                                                                    | Characters it didn't see                                    | Checks the result                       | Needs                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| fontphobia 0.5                                                                                                                                        | What each face draws, crawled in Chrome; or the built text (`auto`)                                          | Rewritten in your source or in the build output                        | Extended and rest files, loaded only by pages that use them | Shaping (HarfBuzz) and pixels in Chrome | Node; Chrome for the crawl and `verify`    |
| [subfont](https://github.com/Munter/subfont) 7.3.0                                                                                                    | Text found by applying the CSS to the built HTML without a browser; `--dynamic` adds headless Chrome         | Rewritten in the build output: a `__subset` family before the original | The original font, loaded by a script after the page        | No                                      | Node; Chromium for `--dynamic`             |
| [glyphhanger](https://github.com/zachleat/glyphhanger) 6.0.0                                                                                          | Text in pages loaded in headless Chrome (Puppeteer) or jsdom; `--spider` follows local links (10 by default) | Prints an `@font-face` block (`--css`); edits nothing                  | Not handled                                                 | None documented                         | Node, Python fontTools (`pyftsubset`)      |
| [cn-font-split](https://github.com/KonghaYao/cn-font-split) 7.4.3                                                                                     | The whole font, split into many `unicode-range` files; the site is not read                                  | Writes the rules for its files                                         | Every file stays available                                  | None documented                         | Node, Bun, Deno or a browser (WebAssembly) |
| [subset-font](https://github.com/papandreou/subset-font) 2.9.0, [`pyftsubset`](https://fonttools.readthedocs.io/en/latest/subset/) (fontTools 4.68.0) | The characters you pass                                                                                      | None                                                                   | —                                                           | No                                      | Node; Python                               |

## Development

```sh
pnpm install
pnpm test                       # unit, golden-hash and crawler tests (crawler tests need Chrome)
pnpm check                      # oxfmt, oxlint, typecheck, knip, dependency-cruiser and the agent skill
pnpm format                     # format with oxfmt; a pre-commit hook checks the staged files
pnpm --filter fontphobia build  # bundles packages/cli/dist and the HarfBuzz WASM
pnpm package:check              # publint and are-the-types-wrong on the packed package
node packages/cli/src/cli.ts --help
```

**Fixture sites** have their own lockfiles. Install them, then run their tests with `FONTPHOBIA_SITES=1`. Pages that link a Google Fonts stylesheet get it from a local stand-in that serves the responses recorded in `fixtures/google-fonts/`; `FONTPHOBIA_RECORD_GOOGLE=1` records a URL that is missing. `FONTPHOBIA_LIVE_GOOGLE=1` uses the real Google instead; the scheduled `Live Google Fonts` workflow runs the self-host and tighten tests that way once a day, and blocks no merge or release when it fails. The `next/font/google` and Fonts API tests (Astro, Nuxt) still need the network, because those frameworks fetch from Google while they build.

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
- Comments cite the design notes by section (`§9.1`) and milestone (`M5`); the notes are not in this repository.
- `spikes/`: research, not part of the build.

**Dependencies** have a 7-day cooldown: pnpm does not install a version published less than 7 days ago (`minimumReleaseAge` in `pnpm-workspace.yaml`, and in each fixture's own file).

**Changes and releases** go through [Changesets](https://github.com/changesets/changesets). A change to the published package comes with a changeset: run `pnpm changeset`, or `pnpm changeset --patch fontphobia -m "..."` without the prompts, and commit the file it writes under `.changeset/`. Every changeset names `fontphobia`, because `packages/core` and `packages/crawler` are bundled into it.

- On a push to `main`, `.github/workflows/version.yml` collects the pending changesets into a "chore: version packages" pull request. It bumps the version, writes [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) and updates the `fontphobia@<version>` pins in `README.md` and `docs/ci.md`. It never publishes.
- Merging that pull request runs `.github/workflows/release.yml`. It typechecks, tests, checks the packed package, publishes to npm with provenance over trusted publishing, tags `fontphobia@<version>` and creates the GitHub release from the changelog entry. It never versions.

The version pull request needs the repository setting "Allow GitHub Actions to create and approve pull requests". GitHub does not run CI on a pull request that Actions opened. To run it, start it on the pull request's branch with `gh workflow run ci.yml --ref changeset-release/main`. The release workflow also runs the typecheck and the tests before it publishes.

## Credits

fontphobia started from [a prompt Shu Ding posted](https://x.com/shuding/status/2115855028737200211) for having an agent shrink a site's web fonts without changing how anything renders. It turns that prompt into a tool. A few things the prompt drops are kept by default, because dropping them can change rendering: hinting and full variable axes are [opt-ins](#opt-ins), and `build` keeps every OpenType feature.

MIT © Amir Abushanab
