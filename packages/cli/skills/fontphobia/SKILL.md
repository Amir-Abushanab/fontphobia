---
name: fontphobia
description: >
  Shrink or subset a website's self-hosted or provider web fonts with the fontphobia CLI, which
  crawls the built site in Chrome and splits each font into core, extended and rest WOFF2 files
  with unicode-range, without changing how text renders. Load this when a user wants to reduce
  font bytes or font payload on a static or SSR site, subset Fontsource, Google Fonts,
  next/font, Astro Fonts API, @nuxt/fonts or Adobe Fonts faces, run or interpret
  `fontphobia audit`, `build`, `verify`, `check`, `revert`, `apply-kit`, `inspect` or `subset`,
  run `fontphobia auto` to subset a built site in its output directory with nothing to commit,
  write a fontphobia.config file, add the post-build check to Vite, Astro, Nuxt, Next.js, React
  Router, VitePress, Docusaurus, Eleventy, Rsbuild, Rspack or webpack, run fontphobia in CI, or
  fix a failing `fontphobia check` or `verify`.
metadata:
  type: core
  library: 'fontphobia'
  library_version: '0.4.1'
sources:
  - 'fontphobia:README.md'
  - 'fontphobia:docs/ci.md'
  - 'fontphobia:packages/cli/CHANGELOG.md'
  - 'fontphobia:packages/cli/src/cli.ts'
  - 'fontphobia:packages/cli/src/config.ts'
  - 'fontphobia:packages/cli/src/integration.ts'
  - 'fontphobia:packages/cli/src/check-runtime.ts'
  - 'fontphobia:packages/cli/src/auto-run.ts'
  - 'fontphobia:packages/core/src/auto/auto.ts'
  - 'fontphobia:packages/cli/src/apply-kit.ts'
  - 'fontphobia:packages/cli/src/vite.ts'
  - 'fontphobia:packages/cli/src/astro.ts'
  - 'fontphobia:packages/cli/src/next.ts'
  - 'fontphobia:packages/core/src/build/manifest.ts'
  - 'fontphobia:packages/core/src/build/revert.ts'
  - 'fontphobia:packages/core/src/check/check.ts'
  - 'fontphobia:packages/crawler/src/verify.ts'
---

# fontphobia: smaller web fonts, same rendering

fontphobia crawls a built site in Chrome and records which characters, weights, OpenType features
and axis values each font face draws on each page. It then splits every face into three WOFF2
files with `unicode-range`: **core** (printable ASCII, common punctuation and the characters the
pages use), **extended** (the Latin and locale characters no page uses yet) and **rest** (everything
else in the original, loaded only if a page needs it). A used character goes in core or extended
by measurement: whichever makes the face's pages download less in total. Glyph names, hinting,
kerning, features and full variable axes are kept, and `verify` compares every page before and
after, pixel for pixel.

## When to use

- A site ships whole font files and most pages draw a small part of them.
- The user wants font bytes cut without a visual change, and wants proof of that (`verify`).
- Fonts come from your own `@font-face` rules, Fontsource, `next/font/local`, Google Fonts,
  `next/font/google`, the Astro Fonts API, `@nuxt/fonts` or Adobe Fonts.
- A project already uses fontphobia and `fontphobia check` started failing after a content change.
- One font file with a known character list: `fontphobia subset`, the low-level tool.

## Requirements

- **Node.js 22 or later.** A `fontphobia.config.ts` needs Node 22.18 or later.
- **Google Chrome, installed normally.** `audit`, `verify` and `check --url` drive it through
  Playwright and download nothing. Set `FONTPHOBIA_CHROME` to another Chrome or Chromium binary.
- **A site that builds.** fontphobia crawls build output. It detects the framework and its build
  command, or uses `dist` and `build` from the config (`--dist`, `--build-cmd`). SSR routes need
  the production server command (`start`, `--start-cmd`). `--url` crawls a running site instead.
- **Optional:** Apple `container`, Docker or Podman, for `verify --browsers linux-*` and `--hinting`.

## Run it

Run from the project root, or pass `--cwd <dir>`. A `--cwd` that is not a directory is an error.

```sh
pnpm dlx fontphobia            # audit, plan, ask, write, verify
pnpm add -D fontphobia         # needed only for the framework integrations
```

`import { defineConfig } from 'fontphobia'` resolves while a config loads even when the package is
not installed, so the `pnpm dlx` path needs no install. If pnpm refuses the release because it is
younger than the project's `minimumReleaseAge`, run it from outside the project with `--cwd`.

## The workflow

### 1. Audit and plan

The default command (no subcommand) audits, prints the plan and the diff, then asks before writing.

- It builds the site in a throwaway copy of the project when there is no build output, so the build
  cannot touch the user's files. The output is kept in `.fontphobia/output` and reused while it is
  newer than every source file.
- It crawls every page it finds at 4 viewport widths (360, 768, 1280, 1920) plus a browser
  default-font-size sweep, and writes `.fontphobia/usage.json` and `.fontphobia/report.md`.
- It prints each face's size now and after, the saving per page, the opt-ins with their measured
  savings, and the exact edits.

The question is asked only on an interactive terminal. With `--ci`, with `CI` set, or with no TTY
(an agent's shell), it prints the plan and `Run with --write to apply.` and writes nothing. Show
the plan to the user and get their agreement before rerunning with `--write`. In the same way, a
stale build is crawled with a warning instead of a rebuild question; pass `--rebuild` after source
changes.

### 2. Write

`fontphobia --write` (or `-u`) skips the question. On write, fontphobia:

- writes the subset files next to the original fonts, named `<stem>.core.<hash8>.woff2`,
  `<stem>.ext.<hash8>.woff2` and `<stem>.rest.<hash8>.woff2`;
- replaces each `@font-face` with a marked block of three rules;
- rewrites `document.fonts.load(font)` and `document.fonts.check(font)` calls in TypeScript, JSX,
  JavaScript and the `<script>` blocks of `.astro`, `.vue`, `.svelte` and `.html` files so they also
  wait for the browser's own font loads;
- records everything it changed in `.fontphobia/manifest.json`.

The write is all or nothing: if one write fails, the files already written are restored. A face
that fails to plan or build, or that `build` cannot match to its `@font-face` rule, is reported and
skipped; the other faces are still built. After writing, the default command runs `verify`.

The same steps, one at a time:

```sh
pnpm dlx fontphobia audit            # crawl; writes .fontphobia/usage.json and report.md
pnpm dlx fontphobia build            # plan from usage.json, no browser; shows plan and diff only
pnpm dlx fontphobia build --write    # apply
pnpm dlx fontphobia verify           # rebuild and compare every page before and after
```

`build` and `verify` fail with "run `fontphobia audit` first" when `usage.json` is missing.

### 3. Review and commit

Commit the subset `.woff2` files, the edited CSS and code, `.fontphobia/manifest.json`, and
`.fontphobia/sources/` when fontphobia copied fonts from Google or a framework. Everything else in
`.fontphobia/` (usage data, report, visit cache, build output, diff images) is ignored by the
`.gitignore` fontphobia writes there. Do not commit it and do not delete the manifest: `check`,
`revert` and reruns read it.

### 4. Undo

```sh
pnpm dlx fontphobia revert --dry-run   # show what would change
pnpm dlx fontphobia revert
```

`revert` puts the original `@font-face` declarations, preloads, imports and `document.fonts` calls
back from the manifest, byte for byte, and removes the manifest. It does **not** delete the
generated `.woff2` files; it lists them for you to delete. If something it changed was edited
since, it reports the problem, keeps the manifest and exits 1. With no manifest it is an error.
Run `revert` before deleting subset files: the CSS still points at them.

## Commands

Most commands take `--json`. `inspect` and `subset` take a file path and no `--cwd`.

| Command          | What it does                                                  | Key options                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fontphobia`     | Audit, plan, ask, write, verify                               | `--write`/`-u`, `--allow`, `--ci`, plus the `audit`, `build` and `verify` options                                                                                            |
| `audit`          | Crawl; write `.fontphobia/usage.json` and `report.md`         | `--dist`, `--build-cmd`, `--start-cmd`, `--url`, `--pages`, `--ignore`, `--viewports`, `--locales`, `--max-pages`, `--rebuild`, `--no-cache`, `--no-font-size-sweep`, `--ci` |
| `build`          | Plan from `usage.json` (no browser); `--write` applies        | `--write`/`-u`, `--allow`, `--core-threshold`, `--no-remainder`, `--usage`                                                                                                   |
| `verify`         | Check files and shaping, then compare pages before and after  | `--browsers`, `--dpr`, `--viewports`, `--mask`, `--ignore`, `--pages`, `--timeout`, `--baseline`, `--hinting`, `--runtime`, `--no-browser`                                   |
| `check`          | Are the subsets still up to date? Static by default           | `--dist`, `--url`, `--mode`, `--strict`, `--allow-chars`                                                                                                                     |
| `auto`           | Subset the built output in place; nothing to commit           | `--dist`, `--crawl`, `--rules`, `--verify`, `--dry-run`, `--allow`, `--core-threshold`, `--no-remainder`                                                                     |
| `revert`         | Restore the originals from the manifest                       | `--dry-run`, `--keep-kits`                                                                                                                                                   |
| `apply-kit`      | Adobe Fonts: remove unused kit styles through the Typekit API | `--yes`, `--check`                                                                                                                                                           |
| `inspect <font>` | A font's tables, axes, features, hinting and sizes            | `--json`                                                                                                                                                                     |
| `subset <font>`  | Subset one font to WOFF2; no crawl, no CSS edits              | `-o` (required, `.woff2`), `--unicodes`, `--text`, `--features`, `--axis`, `--name-ids`, `--no-hinting`                                                                      |

Pages: `--pages` adds paths, or restricts to globs; `--ignore` skips globs. Both repeat. Both also
come from the config's `pages` and `ignore`. `audit` revisits only pages whose HTML, CSS or fonts
changed; `--no-cache` visits every page again.

## Opt-ins

Nothing that could change rendering or where fonts load from happens by default. Enable with
`--allow <name>` (repeatable) or `allow: [...]` in the config. The plan lists each with its
measured saving even when it is off.

| Opt-in           | What it does                                                                                              | Cost                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `self-host`      | Serves Google Fonts from the site, split                                                                  | Changes where fonts load from                              |
| `eject`          | Serves `next/font/google`, Astro Fonts API and `@nuxt/fonts` families from the site, split                | Replaces the framework's font loading in the code          |
| `tighten`        | Drops families and weights nothing asks for from Google URLs and `next/font`, Astro and Nuxt font options | A page the audit never saw, or CMS text, could ask for one |
| `limit-axes`     | Limits variable axes to the ranges in use; drops axes left at the default                                 | Text widths shift up to about 0.02%                        |
| `drop-hinting`   | Removes TrueType hinting                                                                                  | Rasterization changes on Windows, layout on Linux at 1x    |
| `split-shaping`  | Lets words mixing core and extended characters split across files                                         | Kerning is lost where they meet                            |
| `drop-hint-refs` | Drops the reference characters FreeType's auto-hinter needs                                               | Extended characters hint differently on Linux and ChromeOS |

Only pass an opt-in the user chose. Italic styles are never dropped. `--no-remainder` (config
`remainder: false`) drops the rest file: characters no crawled page used then render in the next
font in the stack.

## Font sources

| Source                                                              | Default                                                                                         | With opt-ins                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| Own `@font-face` (CSS, Sass, Less, `<style>` in Vue, Svelte, Astro) | Split in place                                                                                  | All file opt-ins                 |
| Fontsource (`@fontsource/*`, `@fontsource-variable/*`)              | Package CSS copied into the project, each slice a page uses subset, imports pointed at the copy |                                  |
| `next/font/local`                                                   | One subset file per face                                                                        |                                  |
| Google Fonts `<link>` or `@import`                                  | Reports what `tighten` would drop                                                               | `self-host`, `tighten`           |
| `next/font/google`                                                  | Reports unused weights                                                                          | `eject`, `tighten`, `limit-axes` |
| Astro Fonts API                                                     | `<Font preload>` preloads only faces pages use                                                  | `eject`, `tighten`               |
| `@nuxt/fonts`                                                       | Reports unused weights and families loaded twice                                                | `eject`, `tighten`               |
| Adobe Fonts                                                         | Report only; files are never written to disk                                                    | `fontphobia apply-kit`           |
| CSS-in-JS, `new FontFace()`, CMS CSS, computed URLs                 | Subsets, plus the block to paste and where                                                      |                                  |

For the last row, `build` prints "Paste these yourself" blocks, with the file and line they replace
when known. fontphobia does not make those edits.

## Configuration

`fontphobia.config.ts` (also `.mts`, `.mjs`, `.js` or `.json`) at the project root. Every key is
optional. An unknown key or a wrong type is an error naming the file and the key, with a
did-you-mean suggestion for near misses.

```ts
import { defineConfig } from 'fontphobia';

export default defineConfig({
  dist: 'dist', // built site to crawl
  build: 'pnpm build', // how to build it
  start: 'node server.js', // production server, for SSR routes
  url: 'http://localhost:3000', // crawl a running site instead
  pages: ['/', '/blog/**'], // added to the pages found automatically
  ignore: ['/admin/**'],
  auth: { storageState: '.auth.json', pages: ['/account/**'] }, // Playwright login state; pages: globs behind the login (default all)
  viewports: [360, 768, 1280, 1920],
  locales: ['en', 'fr'], // their characters go into the subsets
  maxPages: 500,
  coreThreshold: 'auto', // which used characters go in core: 'auto' measures; 0 to 1 is a fixed share of a face's pages
  remainder: true, // the lazy rest file
  allow: [], // opt-ins, as above
  rename: { 'Source Serif 4': 'SrcSerif Subset' }, // internal name for OFL Reserved Font Names
  licenses: { allow: [] }, // families the user has the rights to modify
  check: { mode: 'error', strict: false, allowChars: '' },
  auto: false, // integrations subset the build output instead of running check: true, 'static' or 'crawl'
  autoRules: 'inline', // where auto puts the split rules: 'inline' (each page) or 'linked' (one cached stylesheet)
  verify: {
    browsers: ['chromium'],
    hinting: false,
    maxPages: 200,
    viewports: [360, 1280],
    dprs: [1, 2],
    mask: [],
    timeout: 30,
  },
});
```

Command-line flags win over the config; `pages`, `ignore` and `verify.mask` are combined with them.
`locales` adds each locale's characters (quotes and so on); `zh-TW` selects Traditional Chinese.

## Keeping the subsets up to date

`fontphobia check` reads the built site and `.fontphobia/manifest.json`. It is static by default:
no browser, no network.

- **Errors:** anything that would render differently: a changed source font, an edited marked
  block, a new `@font-face`, a feature or axis value the subsets dropped, a character no file has.
- **Warnings:** characters that would load the rest file. They render correctly but download more.

Exit codes in the default `--mode error`:

| Situation                                            | Exit |
| ---------------------------------------------------- | ---- |
| No errors (warnings allowed)                         | 0    |
| An error                                             | 1    |
| A warning with `--strict`                            | 1    |
| No `.fontphobia/manifest.json` (nothing was checked) | 1    |
| `check --url` could not load a page                  | 1    |

`--mode warn` (or `check: { mode: 'warn' }`) reports all of these and exits 0. A config that fails
to load still exits 1. When `check` fails, it prints the command to rerun, pinned to the version
recorded in the manifest. Run that command (it audits again and writes), then commit the result.
Characters in the built output that never render go in `--allow-chars` (config
`check.allowChars`) so `check` stops reporting them.

`check --url https://example.com` is exact mode: it crawls the live site in Chrome and compares what
each face draws with the files. It uses the config's `pages`, `ignore` and `auth`, and catches CMS
content the repository never sees.

### Framework integrations

They run `check` when the framework has written its HTML. None of them subsets, opens a browser or
uses the network. Each takes `{ mode: 'warn' | 'error', strict, allowChars }`; options not given
come from the config's `check` key. With no manifest they log a warning and let the build finish.

| Framework                                                | Setup                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Vite (guards only)                                       | `plugins: [fontphobia()]` from `fontphobia/vite`                                          |
| Astro, Starlight                                         | `integrations: [fontphobia()]` from `fontphobia/astro`                                    |
| Nuxt                                                     | `modules: ['fontphobia/nuxt']`, or `[['fontphobia/nuxt', { mode: 'warn' }]]`              |
| Next.js                                                  | `adapterPath: fileURLToPath(import.meta.resolve('fontphobia/next'))` in `next.config.mjs` |
| React Router                                             | `buildEnd: fontphobia()` from `fontphobia/react-router` in `react-router.config.ts`       |
| VitePress                                                | `buildEnd: fontphobia()` from `fontphobia/vitepress`                                      |
| Docusaurus                                               | `plugins: ['fontphobia/docusaurus']`                                                      |
| Eleventy                                                 | `eleventyConfig.addPlugin(fontphobia)` from `fontphobia/eleventy`                         |
| Rsbuild                                                  | `plugins: [fontphobia()]` from `fontphobia/rsbuild`                                       |
| Rspack, webpack                                          | `plugins: [new FontphobiaPlugin()]` from `fontphobia/rspack` or `fontphobia/webpack`      |
| Anything else (SvelteKit, TanStack Start, Angular, Hugo) | `"postbuild": "fontphobia check"` in `package.json`                                       |

```js
// next.config.mjs
import { fileURLToPath } from 'node:url';

export default {
  adapterPath: fileURLToPath(import.meta.resolve('fontphobia/next')),
};
```

Notes from the source:

- `fontphobia/vite` does not run `check`. It keeps the subset files out of Vite's asset inlining
  (an inlined extended or rest file would download on every page) and, in dev, logs a console
  warning when text uses a character outside a face's core and extended files. Pair it with a
  `postbuild` check, or use it beside the React Router or VitePress integration.
- The Next adapter takes no options; it reads them from the config's `check` key.
- The VitePress and Eleventy integrations use the working directory as the project root; pass
  `{ root }` when the build does not run from the directory that holds `.fontphobia/`.
- The Rspack and webpack plugin skips the check in `mode: 'development'`.

## Auto mode

`fontphobia auto` subsets the fonts of a built site inside its output directory. It edits no source
file, writes no manifest and leaves nothing to commit; the output is subset again on every build.
Use it when the user wants no workflow to maintain and the site is prerendered HTML. Use the default
flow when the site renders pages on a server, when a provider (Google, Adobe) serves the fonts, or
when a reviewed diff and a one-time `verify` are wanted.

```sh
pnpm build && pnpm dlx fontphobia auto            # static: reads the built text, no browser
pnpm build && pnpm dlx fontphobia auto --crawl    # measures each face in Chrome
```

- **Static** gives every face the page characters it can draw (its own glyphs, within its
  `unicode-range`) and keeps all of a font's OpenType features, so its files are larger. **`--crawl`** writes the same files the default flow would,
  and needs Chrome wherever the build runs.
- **What it writes, in the output only:** the core, extended and rest files next to each font; the
  split rules in a `<style>` at the end of each page's `<head>` (inline, so no stylesheet can load
  between them and the original rules); a `unicode-range` on each original `@font-face`, which
  stays as the fallback for pages without the split rules; and preloads pointed at the core file,
  Next's preload hints included. A face only a page's own `<style>` declares is replaced there.
- **A font whose pages would not download less is skipped** (an already small Google or Fontsource
  slice): the report says so. The rules cost about 1 KB compressed in each page's HTML,
  and a Content-Security-Policy without inline styles makes the browser ignore them.
- **`--rules linked`** (config `autoRules: 'linked'`) writes the rules to one cached stylesheet,
  `fontphobia.<hash>.css`, linked last in each page. Use it under a strict Content-Security-Policy.
  Its cost: the original font can download now and then while that stylesheet is on its way.
- **Every run checks, without a browser,** that each file decodes and matches its source, that the
  rules keep the original descriptors and that every word shapes identically. A failure puts the
  output back as it was and exits 1.
- **`--verify`** adds the pixel comparison in Chrome. Run it when adopting auto mode, after a font
  or fontphobia version changes, or in CI; it is not needed on every build. It also reports an
  original font a page still downloads (a script loads it by URL).
- **Options:** `--dist`, `--dry-run`, `--json`, `--allow` (`drop-hinting`, `split-shaping`,
  `drop-hint-refs` only), `--core-threshold`, `--no-remainder`. Crawl settings (`pages`, `ignore`,
  `viewports`, `locales`, `auth`) come from the config.
- **Integrations:** each one's options take `auto: true` (static) or `auto: 'crawl'`, which
  replaces the post-build `check`. The config's `auto` key does the same for an integration
  without the option; the Next adapter takes no options and reads that key.
- **It refuses** a project that has `.fontphobia/manifest.json` (run `revert` first) and an output
  it already subset (build again first).
- **It leaves alone** fonts another origin serves, rules inside `@media` or `@supports`, rules a
  script declares, families nothing in the output names and fonts the license rules refuse. It
  does not rewrite `document.fonts.load()` calls or edit a stylesheet loaded with `integrity`.

## CI

Pin CI to the fontphobia version that wrote the manifest (`pnpm dlx fontphobia@<version>`); the
manifest records it. Full workflow files are in `docs/ci.md` in the fontphobia repository.

- **Every pull request:** install, build the site, then `pnpm dlx fontphobia check`. Skip this if a
  framework integration already runs the check in the build.
- **Production on a schedule:** `pnpm dlx fontphobia check --url https://example.com`. GitHub's
  runner images have Chrome.
- **Verify on Windows and Linux** when fonts change (for example on pull requests that touch
  `.fontphobia/manifest.json`): `pnpm dlx fontphobia verify` on `windows-latest`, and add
  `--hinting` on `ubuntu-latest`. Upload `.fontphobia/verify` as an artifact on failure.

`verify` builds and serves the site itself. For an SSR site, set `start` in the config.

## Reading `verify`

`verify` needs `.fontphobia/usage.json` and runs in three stages:

1. Every output file is decoded and validated, and the CSS is checked against the original
   descriptors.
2. Every recorded word is shaped with HarfBuzz from the original and from the split files; the
   results must be identical.
3. Every page is loaded before and after in the browser, and layout and every pixel are compared.

`--no-browser` runs stages 1 and 2 only. The "before" side is the same build with the original
fonts swapped back (`--baseline overlay`). `--baseline worktree` builds `HEAD` in a temporary git
worktree instead; that is the default after `eject` or option narrowing, because those change what
the framework builds.

Each page comparison gets a class:

| Class                | Meaning                                                                  | Fails the run |
| -------------------- | ------------------------------------------------------------------------ | ------------- |
| `identical`          | No difference                                                            | No            |
| `sub-pixel rounding` | Difference explained by rounding that shaping reported                   | No            |
| `unrelated`          | Pixels differ only in text drawn with fonts fontphobia did not change    | No            |
| `flaky`              | A pixel difference that did not repeat when both sides were loaded again | No            |
| `content changed`    | Page text differs between two loads; left out                            | No            |
| `regression`         | A real difference, reported with the element's CSS selector              | Yes           |
| `failed`             | The page did not load                                                    | Yes           |

A pixel difference at unchanged layout is loaded again, each time in a new browser, and is a
regression when the same pixels differ every time. Chrome rasterizes on the CPU during `verify`:
its GPU rasterizer does not draw large text the same way on every load.

`verify` exits 1 on a regression or a failed page. Diff images go to `.fontphobia/verify/` and the
summary to `.fontphobia/report.md`. For content that changes between loads (script-driven
animations, canvases, embeds), hide it with `--mask <selector>` or skip the page with
`--ignore <glob>`; raise `--timeout` (seconds, default 30) for slow pages. `--browsers` adds
`firefox`, `webkit` (Playwright builds on the host; when one is not installed, fontphobia prints
the install command with the matching Playwright version) and `linux-chromium`, `linux-firefox`,
`linux-webkit` (the pinned Playwright Linux image in a container). Above `--max-pages` (default 200) a set cover picks representative pages.

## Licenses

fontphobia modifies only fonts whose license it recognizes as open: SIL OFL, Apache 2.0, the Ubuntu
Font Licence, the Bitstream Vera license, MIT, CC0 and GPL with the font exception. It reads the
license from the font's name table, from a license file next to the font or in a folder above it
inside the project (`OFL.txt`, `LICENSE`, `<Family>-LICENSE.txt`), or, in `node_modules`, from the
font package. The project's own `LICENSE` and `package.json` never count.

- Other fonts are refused unless the family is listed under `licenses.allow`. Add a family there
  only when the user confirms they have the rights to modify it.
- Fonts whose `fsType` forbids subsetting are refused.
- **OFL Reserved Font Names:** the subset files are renamed internally, as the license requires.
  The decision comes from the font's own family name. The CSS `font-family` stays the same, so
  pages do not change. `rename` chooses the internal name.

## Adobe Fonts

fontphobia never writes Adobe Fonts files. The audit report lists the kit settings to change, with
measured savings. `apply-kit` removes unused styles through the Typekit API and needs
`TYPEKIT_TOKEN` (from fonts.adobe.com/account/tokens).

- It **publishes the kit**, which changes every site that uses it. Ask the user first.
- It refuses a kit whose draft has unpublished changes, reads each change back before publishing,
  and without a terminal it applies nothing unless `--yes` is given (exit 1, "Not applied").
- `apply-kit --check` confirms the live kit still serves every face and character the pages use;
  another site sharing the kit can run it. It exits 1 when something is missing.
- `revert` restores the previous styles only if nobody edited the kit since; otherwise it says which
  styles to add back. `revert --keep-kits` leaves the kit as it is.
- The character set cannot be changed through the API; the report says which one to pick on
  fonts.adobe.com.

## Limitations

- **Text the crawl cannot see** is not counted when the files are planned: pages behind a login (use
  `auth`), text scripts add after load, and content added later. Its characters render from the
  extended file when they are in Latin-1, Latin Extended-A or the alphabets of `locales`, and from
  the rest file otherwise (with `remainder: false`, in the next font in the stack).
- **CFF fonts** that need an OFL Reserved Font Name rename are not supported yet.
- **`apply-kit`** affects every site using the kit and does not change the kit's character set.

## Common mistakes

- **Running before the site builds.** fontphobia needs build output or a working build command.
  When detection fails, set `dist` and `build` (and `start` for SSR) in the config.
- **Expecting the bare command to write in a non-interactive shell.** Without a TTY it only plans,
  and a stale build is crawled as it is. Use `--write` after the user agrees, and `--rebuild`.
- **Treating `check` exit 1 with no manifest as a bug.** It means nothing was checked. Run the
  write step first, or use `--mode warn` where an unconfigured project must still pass.
- **Committing all of `.fontphobia/`, or ignoring the manifest.** Commit `manifest.json` and
  `sources/` only; the bundled `.gitignore` already does this.
- **Editing inside a marked `@font-face` block by hand.** `check` reports it as an error. Rerun
  fontphobia instead, or `revert` first.
- **Enabling opt-ins to chase the biggest number.** `limit-axes`, `drop-hinting`, `split-shaping`
  and `drop-hint-refs` change rendering on some platforms; `tighten`, `self-host` and `eject`
  change what or where fonts load. Each needs the user's choice.
- **Hiding a `verify` regression with `--mask` or `--ignore`.** Use them for content that changes on
  its own between loads, not for a difference in text the fonts draw.
