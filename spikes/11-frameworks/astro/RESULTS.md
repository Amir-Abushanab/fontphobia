| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Astro 7.4.5 (Vite 8.3.5) | `astro` dep + `astro.config.{mjs,ts}` | Default `output: 'static'` → `dist/` with directory-style `about/index.html`, `posts/1/index.html` (`build.format: 'directory'`). With an adapter: `dist/client/` (prerendered HTML) + `dist/server/entry.mjs` | Static: `astro preview` (:4321, moves to 4322 if busy, **auto-backgrounds and emits JSON when an AI agent is detected**; `--ignore-lock` keeps it in the foreground). SSR: `@astrojs/node` standalone → `node dist/server/entry.mjs` (:4321, `PORT`/`HOST` env) | `src/pages/**` (file-based, `getStaticPaths`); no manifest file for static builds. Use the `astro:build:done` `pages[].pathname` integration hook, or walk `dist/**/index.html`. SSR route table is serialized inside `dist/server/entry.mjs` (`"route":"/posts/[id]"`) | Layout component `src/layouts/*.astro` `<head>` (Google `<link>` kept byte-for-byte, `&` unescaped). Fontsource CSS is **inlined as `<style>`** (`build.inlineStylesheets: 'auto'`, <4 kB); woff2 → `dist/_astro/inter-latin-wght-normal.<8-char hash>.woff2`, not inlined. Fonts API → `dist/_astro/fonts/<16-hex>.woff2` | Vite `closeBundle` fires 5× (static: `ssr`, `astro`, `client` during sync, then `prerender`, `client`); all fire **before** HTML generation. Use the integration hook `astro:build:done` (`{dir, pages}`), which runs once after all HTML is written |

# Evidence

Scaffold: `pnpm create astro@5.3.1 astro --template minimal --no-install --no-git --yes --skip-houston`. Versions: `astro@7.4.5` (npm latest), `vite@8.3.5`, `@astrojs/node@11.1.9`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. `allowBuilds: {esbuild: true, sharp: false}`. There were no minimum-release-age blocks.

Fixture: `src/layouts/Layout.astro` imports `@fontsource-variable/inter` and holds the Fraunces `<link>` plus the conditional `<Font>` tags. Pages: `index.astro`, `about.astro`, `posts/[id].astro` (with `getStaticPaths` → 1, 2 and `prerender = true`). `astro.config.mjs` has the probe Vite plugin, a probe integration, and env toggles: `ASTRO_FONTS=1|roboto-only` for the Fonts API and `ASTRO_SSR=1` for the node adapter.

Static build (`evidence/build-static.log`):
```
[probe] closeBundle ssr
[probe] closeBundle astro
[probe] closeBundle client
[build] output: "static" ... Building static entrypoints...
[probe] closeBundle prerender
[probe] closeBundle client
 generating static routes
  ├─ /about/index.html  ├─ /posts/1/index.html  ├─ /posts/2/index.html  ├─ /index.html
[probe] astro:build:done .../astro/dist/ ["about/","posts/1/","posts/2/",""]
```
Output: `dist/{index.html,about/index.html,posts/1/index.html,posts/2/index.html,favicon.*}` and `dist/_astro/inter-{latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-wght-normal.<hash>.woff2`. No `.css` file is emitted: the fontsource `@font-face` set (1947 B) is in a `<style>` in every page, with `url(/_astro/inter-...woff2)`, `format("woff2-variations")` and `unicode-range` preserved. The CSS has no `data:` URIs.

SSR build (`ASTRO_SSR=1`, `evidence/build-ssr-node.log`) gives `dist/client/posts/{1,2}/index.html` plus `dist/server/entry.mjs`, and `astro:build:done` reports `dir=dist/client/, pages=["posts/1/","posts/2/"]`. `PORT=4329 node dist/server/entry.mjs` → `[@astrojs/node] Server listening on http://localhost:4329`; `/`, `/about`, `/posts/2/` all returned 200. The default port 4321 was taken by an unrelated process on this machine (EADDRINUSE).

`astro preview`: `{"message":"Preview server running at http://localhost:4322 (pid 11020)\n Stop: astro preview stop ...","level":"info"}`. The process returned immediately, and `curl :4322/posts/2/` returned 200 with `<h1>Post 2</h1>`. Source: `dist/cli/preview/index.js:37-45`. When `isRunByAgent()` is true and `ASTRO_PREVIEW_BACKGROUND` is unset, the command forces JSON logs and background mode. Use `--ignore-lock` for a foreground one-off; `astro preview stop|status|logs` manage the daemon.

## Fonts API

- **Stable.** In 7.4.5 it is the top-level config key `fonts: FontFamily[]` (`dist/core/config/schemas/base.js:296`); `experimental` has no fonts flag. Providers come from `import { fontProviders } from 'astro/config'`: `adobe, bunny, fontshare, fontsource, google, googleicons, local, npm` (`dist/assets/fonts/providers/index.js:173`). Render it with `import { Font } from 'astro:assets'` and `<Font cssVariable="--x" preload />`. The runtime exports `fontData` and `experimental_getFontFileURL` from `astro:assets`.
- **Option names** (`dist/assets/fonts/config.js` `FontFamilySchema`, strict): `name, cssVariable, provider, weights, styles, subsets, formats, fallbacks, optimizedFallbacks, display, stretch, featureSettings, variationSettings, unicodeRange, options`. Defaults (`dist/assets/fonts/constants.js`): `weights ['400'], styles ['normal','italic'], subsets ['latin'], fallbacks ['sans-serif'], optimizedFallbacks true, formats ['woff2']`. `<Font>` props are `cssVariable` and `preload` (bool or filter).
- **CSS emitted:** an inline `<style>` per `<Font>` in that page's `<head>`, and for `preload` a `<link rel="preload" as="font" type="font/woff2" crossorigin>` per file. The family name is **hashed**, so the CSS variable is the stable handle (`evidence/build-fonts-api.log`, `dist/about/index.html`):
  ```
  @font-face{font-family:Roboto-4695a571cd365f71;src:url("/_astro/fonts/81458467d34e233f.woff2") format("woff2");font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;font-weight:400 700;font-style:normal;}
  @font-face{font-family:"Roboto-4695a571cd365f71 fallback: Arial";src:local("Arial");font-display:swap;font-weight:400 700;font-style:normal;size-adjust:97.0427%;ascent-override:95.6006%;descent-override:25.1581%;line-gap-override:0%;}
  :root{--font-roboto:Roboto-4695a571cd365f71,"Roboto-4695a571cd365f71 fallback: Arial",sans-serif;}
  ```
  The provider's `unicode-range` is copied through. Lora with `fallbacks: ['serif']` got a `fallback: Times New Roman` face (`size-adjust:112%`).
- **Where files land:** `dist/_astro/fonts/<16-hex content hash>.<ext>` (`ASSETS_DIR = "fonts"` under `build.assets`; `vite-plugin-fonts.js:297-317` copies them in the client environment's build, logging `[assets] Copying fonts (4 files)...`). In SSR builds they go under `dist/client/_astro/fonts/`. The download cache is `node_modules/.astro/fonts/` (in dev, `.astro/fonts`). File ids come from `infra/build-font-file-id-generator.js` (a hash of the file content).
- **Fallback metrics:** `dist/assets/fonts/core/optimize-fallbacks.js` applies only when the last `fallbacks` entry is a generic family. It maps the generic to local fonts via `infra/system-fallbacks-provider.js`, whose hardcoded `SYSTEM_METRICS` (Times New Roman, Arial, Courier New, ...) are extracted from capsize `entireMetricsCollection.json`. It reads the web font's metrics with `infra/capsize-font-metrics-resolver.js` (`@capsizecss/unpack` `fromBuffer`, which downloads the first font file) and computes `size-adjust` from the `xWidthAvg/unitsPerEm` ratio plus `ascent/descent/line-gap-override` (adapted from capsize `createFontStack.ts` and fontaine `metrics.ts`). Set `optimizedFallbacks: false` to turn it off.
- **Removing one family:** the API is opt-in per entry, and nothing is handled unless it is listed. Delete that family's object from `fonts[]` **and** its `<Font cssVariable>` tag. `ASTRO_FONTS=roboto-only` copied 2 files instead of 4 and left no Lora in the HTML. If the `<Font cssVariable="--font-lora">` tag stays, the build fails: `FontFamilyNotFound: No data was found for the "--font-lora" family passed to the <Font> component` (`evidence/build-fonts-orphan-component.log`). There is no `provider: 'none'` equivalent. The plain Google `<link>` (Fraunces) and fontsource imports are never touched by the Fonts API.

# Surprises / gotchas
- `astro preview` daemonizes and switches to JSON logs when it detects an agent (it did here). fontphobia should pass `--ignore-lock`, or set `ASTRO_PREVIEW_BACKGROUND`, or track the PID and run `astro preview stop`. The port also auto-increments when busy, so parse the URL from the output.
- Fontsource CSS is inlined into every HTML page by `inlineStylesheets: 'auto'`. There is no CSS file to rewrite; fontphobia has to rewrite `<style>` blocks in the HTML, or set `build.inlineStylesheets: 'never'`.
- Fonts API family names are hashed (`Roboto-4695a571cd365f71`), and the files are content-hashed without the family name in the filename.
- `closeBundle` fires 3× even before the build proper (sync/types phase), then 2× more. Its count and env order differ between static and SSR builds, and it is never the last step.
- pnpm 12 `pnpm build` runs a lockfile supply-chain verification + install check before the script.
- `astro@7.4.5` was published about 6 h before this run. Its exact `^7.4.5` range (written by create-astro) installed it without complaint despite pnpm 12's minimum release age. The Starlight template's `^7.2.10` range resolved to 7.4.4 instead (see starlight/RESULTS.md).
