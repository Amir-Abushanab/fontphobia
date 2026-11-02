| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Nuxt 4.6.3 (Nitro 2.13.5, Vite 8.3.5) | `nuxt` dep + `nuxt.config.{ts,js,mjs}` | `nuxt generate` (preset `static`) → `.output/public/` (`about/index.html`, `posts/1/index.html`, `200.html`, `404.html`, `_payload.json`); `dist` → symlink to it. Prerender list from `nitro.prerender.routes` (+ crawler) or `routeRules: {x: {prerender: true}}` | `nuxt build` (preset `node-server`) → `node .output/server/index.mjs` (:3000, `PORT`/`NITRO_PORT`); the exact command is in `.output/nitro.json` `commands.preview`. `/posts/3` → 200 (SSR) | `app/pages/**` (`[id].vue`). Machine list: `.output/public/_nuxt/builds/meta/<buildId>.json` `prerendered: ["/","/about","/posts/1","/posts/2"]`, or the Nitro `prerender:done` hook | `app.head.link` in `nuxt.config.ts` (or `useHead`); Google `<link>` kept as-is. Fontsource via `css: ['@fontsource-variable/inter']` → `.output/public/_nuxt/entry.<hash>.css`, woff2 `_nuxt/inter-*-wght-normal.<hash>.woff2`; component `<style>` is inlined into HTML (`features.inlineStyles`) | Vite `closeBundle` 2× (`client`, `ssr`) before prerender. Post-HTML: Nitro hook `prerender:done` (has the route list), then Nuxt `nitro:build:public-assets`, then `close` (last) |

# Evidence

Versions: `nuxt@4.6.3` (npm latest), `nitropack@2.13.5`, `vite@8.3.5`, `vue@3.5.44`, `vue-router@5.4.0`, `@nuxt/fonts@1.2.0` (→ `fontless@1.3.4`, `fontaine@1.0.3`, `unifont@1.0.3`), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier attempt's scaffold (the `minimal` template: `package.json`, `nuxt.config.ts` with `compatibilityDate: '2025-07-15'`, `app/app.vue`). `allowBuilds: {esbuild: true}`.

Fixture:
- `nuxt.config.ts`:
  - `css: ['@fontsource-variable/inter']`.
  - `app.head.link` for the preconnect and Fraunces stylesheet.
  - `nitro.prerender.routes`.
  - The probe Vite plugin.
  - Nitro hooks (`compiled`, `prerender:done`, `close`) and Nuxt hooks (`build:done`, `nitro:build:public-assets`, `close`).
  - `NUXT_FONTS=1|no-fraunces` toggles `@nuxt/fonts`.
- Pages: `index.vue`, `about.vue` (CSS references `Fraunces` and `Lora`), `posts/[id].vue`.

`pnpm generate` (`evidence/generate.log`):
```
[probe] closeBundle client
[probe] closeBundle ssr
[probe] nuxt build:done
[nitro] ℹ Initializing prerenderer
[probe] nitro compiled
[nitro] ℹ Prerendering 6 initial routes with crawler  ... /200.html /404.html / /about /posts/2 /posts/1 + _payload.json
[probe] nitro prerender:done ["/200.html","/404.html","/","/about","/posts/2","/posts/1","/_payload.json",...]
[nitro] ✔ Generated public .output/public
[probe] nuxt nitro:build:public-assets
[probe] nitro compiled
[probe] nuxt close
[probe] nitro close
```
`pnpm build` (`evidence/build.log`) is the same sequence with preset `node-server`, followed by `Building Nuxt Nitro server` after the public assets. `.output/nitro.json` is `{"preset":"node-server","framework":{"name":"nuxt","version":"4.6.3"},"commands":{"preview":"node server/index.mjs"}}`; the static preset has `"preview":"npx serve public"`. `PORT=3011 node .output/server/index.mjs` → `Listening on http://[::]:3011`. `/`, `/about`, `/posts/2`, `/posts/3` all returned 200.

Built `about/index.html` head:
```
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap">
<link rel="stylesheet" href="/_nuxt/entry.obYOgHia.css" crossorigin>
<style>body{font-family:Inter Variable,sans-serif}</style><style>.fraunces{font-family:Fraunces,serif}.lora{...}</style>
```
The fontsource faces are in `entry.<hash>.css` with `url(./inter-latin-wght-normal.Dx4kXJAl.woff2)`. There are no `data:` URIs.

Build internals: Nuxt 4.6 production builds use **`node_modules/.cache/nuxt/.nuxt/`** as the buildDir (`dist/client/manifest.json` is there). The root `.nuxt/` only holds `nuxt prepare` types.

## @nuxt/fonts

- **Options** (`configKey: 'fonts'`; types in `fontless/dist/utils-*.d.mts`):
  - Top-level: `families[]`, `defaults{preload, glyphs, weights, variableAxis, styles, subsets, formats, fallbacks}`, `providers{adobe,bunny,fontshare,fontsource,google,googleicons,npm,...: factory|string|false}`, `priority[]`, `provider` (a single global provider), `processCSSVariables` (`'font-prefixed-only'` default), `throwOnError`, `devtools`, `cache` (false, a dir, or storage), `assets{prefix, strategy:'public'}`, `experimental{disableLocalFallbacks}`, plus per-provider option keys (`google`, `adobe{id}`, `npm`, ...).
  - Per family: `name, provider, providerOptions, weights, styles, subsets, glyphs, variableAxis, display, unicodeRange, fallbacks, preload, global`, or manual `src`.
  - Module defaults: `weights ['400 700']` (`@nuxt/fonts/dist/module.mjs` setup), all subsets from cyrillic-ext to latin, `formats ['woff2']`.
  - `glyphs` / `variableAxis` trigger a build-time **subsetter** (`ensureSubsetter`).
- **How it works:** it scans every CSS `font-family` declaration (including in `.vue` `<style>`) and resolves each unknown family through its providers: `local`, `npm` (node_modules), `google`, `bunny`, `fontshare`, `fontsource`, `adobe`. It then injects `@font-face` rules plus fallback faces next to the usage and **rewrites the `font-family` stack** to include the fallback names.
- **CSS emitted** (`evidence/generate-nuxt-fonts.log`, `_nuxt/about.<hash>.css`):
  ```
  @font-face{font-family:Lora;src:local(Lora Variable Italic),url(./fonts/slgyf3Ou...woff2)format("woff2");font-display:swap;unicode-range:U+460-52F,...;font-weight:400 700;font-style:italic}
  @font-face{font-family:Lora Fallback\: Times New Roman;src:local(Times New Roman),local(Times New Roman Regular),local(TimesNewRoman-Regular),local(TimesNewRomanPSMT);size-adjust:115.2%;ascent-override:87.3264%;descent-override:23.7847%;line-gap-override:0%}
  ... Fallback\: Georgia / Noto Serif / Liberation Serif
  ```
  Fallback stacks come from fontaine `DEFAULT_CATEGORY_FALLBACKS`. For sans-serif that is Segoe UI, Helvetica Neue, Arial, Noto Sans, Liberation Sans; for serif it is Times New Roman, Georgia, Noto Serif, Liberation Serif. When component styles are inlined, the faces are also hoisted into an inline `<style>` in the HTML (the `runtime/nitro/inline-font-faces` Nitro plugin).
- **Where files land:** `.output/public/_nuxt/fonts/<sha256-base64url>-<...>.woff2`. With `buildAssets`, the URL is `app.buildAssetsDir + (assets.prefix || 'fonts')`; otherwise it is `/_fonts` (`module.mjs:145`). The download cache is `node_modules/.cache/nuxt/fonts/`.
- **Fallback metrics:** `fontless/dist/parse-*.mjs:108` `generateFontFallbacks()`. It uses the provider-supplied metrics, or fontaine `getMetricsForFamily(family)` (capsize's metric collection), or `readMetrics(fontURL)` (fontaine parses the downloaded file; cached as `data:metrics:<sha256>.json`, `fontless/dist/index.mjs:975`). The CSS comes from fontaine `generateFontFace(metrics, {font, name, metrics: getMetricsForFamily(fallback)})`, which computes `size-adjust` and the `ascent/descent/line-gap-override` values.
- **Excluding one family:** `fonts: { families: [{ name: 'Fraunces', provider: 'none' }] }` is still the mechanism (`FontProviderName = string | "google" | "local" | "none"`; `fontless/dist/index.mjs:626` `if (override?.provider === "none") return;`). Verified (`evidence/generate-nuxt-fonts-no-fraunces.log`): it made 0 Fraunces downloads, emitted no Fraunces faces, and left `.fraunces{font-family:Fraunces,serif}` untouched, while Lora was still processed. `providers: { google: false }` disables a whole provider.

# Surprises / gotchas
- **@nuxt/fonts duplicates the Google `<link>` font.** Fraunces is loaded by `<link>` and also self-hosted (6 faces downloaded from gstatic), because the module only looks at CSS, not head links.
- **@nuxt/fonts re-processes fontsource.** Its `npm` provider resolved `Inter Variable` from `node_modules/@fontsource-variable/inter/files/*.woff2` (logged as `file:///...`) and emitted 7 new faces into `_nuxt/fonts/`. The original 7 fontsource faces (`_nuxt/inter-*.woff2`) stay, so there are 14 `Inter Variable` faces and 2 copies of every file. It also produced two `Inter Variable Fallback: Arial` faces with conflicting `size-adjust` (134.283% vs 107.119%). The new faces get `src: local(Inter Variable Variable)`, a doubled "Variable".
- fontphobia should detect `@nuxt/fonts` in `modules` and either rewrite its `_nuxt/fonts/*` output or tell users to set `provider: 'none'` for the families it manages.
- @nuxt/fonts 1.2 has its own build-time subsetting (`glyphs`, `variableAxis`), which overlaps with fontphobia's job.
- The Nuxt 4.6 buildDir for builds moved to `node_modules/.cache/nuxt/.nuxt`. The root-level `.nuxt` is only for types.
- `nuxt generate` crawls links (`Prerendering 6 initial routes with crawler`) and also writes `200.html`/`404.html`. `nuxt build` with `prerender.routes` writes only the listed routes into `.output/public` and serves the rest via SSR.
