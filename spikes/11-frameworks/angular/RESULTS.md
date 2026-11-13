| Framework                                                            | Detected by                                                                                                                                           | Static output                                                                                                                                                                                                                                                                 | Server mode                                                                                                                                                                                                                                                                     | Routes                                                                                                                                                                       | Head / fonts                                                                                                                                                                                                                                                                                                                                            | Plugin                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Angular 22.2 (`@angular/build:application`, esbuild; `ng new --ssr`) | `@angular/core` dep + `angular.json` (`projects.*.architect.build.builder` = `@angular/build:application`; `outputPath` defaults to `dist/<project>`) | `browser/` under `dist/<project>/` with directory-style `about/index.html`, `posts/1/index.html` + `index.csr.html`; prerender via `app.routes.server.ts` `RenderMode.Prerender` (+ `getPrerenderParams`); `--output-mode static` (or `outputMode: 'static'`) drops `server/` | `outputMode: 'server'` → `node dist/<project>/server/server.mjs` (:4000, `PORT`). **Starter sets `security.allowedHosts: []`, so every request (even `localhost`) gets 400** until `NG_ALLOWED_HOSTS=localhost` (or the angular.json list) is set. Unknown `/posts/3` → SSR 200 | `src/app/app.routes.ts` (+ `app.routes.server.ts`). Machine list: **`dist/<project>/prerendered-routes.json`** `{"routes":{"/":{},"/about":{},"/posts/1":{},"/posts/2":{}}}` | `src/index.html` (static template). **The Google `<link>` is removed and its CSS inlined as `<style>`** (`optimization.fonts.inline`, default on; fetched at build). Fontsource woff2 → `browser/media/inter-*-wght-normal-<8 char>.woff2`, CSS `styles-<hash>.css`; Beasties inlines the critical `@font-face` and adds a `<link rel=preload as=font>` | No user plugin option in `angular.json` (application builder schema has no `plugins`). Only route: a custom builder calling `buildApplication(opts, ctx, {codePlugins, indexHtmlTransformer})` (marked "experimental, NOT supported"). esbuild `onEnd` 3× (`browser`, `node`, `node`) before prerender; the builder's yielded result is after all HTML |

# Evidence

Versions: `@angular/cli@22.2.5`, `@angular/build@22.2.5`, `@angular/ssr@22.2.5`, `@angular/core@^22.2.0` (npm latest 22.2.4), `typescript@6.0.3`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier `ng new --ssr` scaffold (it has `outputMode: "server"`, `ssr.entry: src/server.ts`, `serverRoutes` `**` Prerender, and `security.allowedHosts: []`). `allowBuilds: {esbuild, @parcel/watcher, lmdb, msgpackr-extract: true}`.

Fixture:

- `src/index.html`: preconnect + Fraunces `<link>`.
- `src/styles.css`: `@import '@fontsource-variable/inter'`.
- Routes `''`, `about`, `posts/:id` (`src/app/pages/*.ts`); `app.routes.server.ts` prerenders `posts/:id` with `getPrerenderParams → [{id:'1'},{id:'2'}]`.
- Probe: `tools/probe-builder/` (a local Architect builder), run as the `build-probe` target (`pnpm ng run angular:build-probe`).

`ng build` (`evidence/build-server.log`): browser bundle `main-634N3YST.js`, `styles-TZO2HXKZ.css`; server bundle `server.mjs`, `main.server.mjs`, `polyfills.server.mjs`; then `Prerendered 4 static routes.` Output:

```
dist/angular/browser/{index.html,index.csr.html,about/index.html,posts/1/index.html,posts/2/index.html,styles-TZO2HXKZ.css,media/inter-*-wght-normal-XXXXXXXX.woff2}
dist/angular/prerendered-routes.json
dist/angular/server/{server.mjs,main.server.mjs,angular-app-manifest.mjs,angular-app-engine-manifest.mjs,index.server.html,assets-chunks/*_html.mjs}
```

Head of built `about/index.html`:

```
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">     <- added by font inlining
<link rel="icon" type="image/x-icon" href="favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>@font-face{font-family:'Fraunces';...src:url(https://fonts.gstatic.com/s/fraunces/v38/...woff2) format('woff2');unicode-range:...}  (3 faces: vietnamese, latin-ext, latin)</style>
<link rel="preload" as="font" crossorigin="anonymous" href="/media/inter-latin-wght-normal-NRMW37G5.woff2">
<style>@font-face{font-family:Inter Variable;...src:url("/media/inter-latin-wght-normal-NRMW37G5.woff2") format("woff2-variations");unicode-range:U+0000-00FF,...}</style>
<link rel="stylesheet" href="styles-TZO2HXKZ.css" media="print" data-beasties-media="all">  (+ noscript/onload swap)
```

None of the built HTML (`index.html`, `about/index.html`, `index.csr.html`) contains `fonts.googleapis.com/css2`. Schema: `optimization.fonts.inline` = "inlining external Google Fonts and Adobe Fonts CSS definitions in the application's HTML index file. This option requires internet access", default `true`. Opt out with `"optimization": {"fonts": false}` or `{"fonts": {"inline": false}}`. The CSS has no `data:` URIs.

`server/angular-app-manifest.mjs` contains `criticalCssPlans: [[1,"/styles-TZO2HXKZ.css",2087,["Inter Variable"],...,["@font-face{...inter-cyrillic-ext...}",[1,"/media/inter-cyrillic-ext-wght-normal-IYF56FF6.woff2",[1120,1327,7296,...]]]...` That is a per-`@font-face` codepoint plan used at SSR time to pick which faces to inline and preload. That's why only the latin face appears on the about page.

Server: `PORT=4011 node dist/angular/server/server.mjs` → `Node Express server listening on http://localhost:4011`, but every route returned **400** with `Header "host" with value "localhost:4011" is not allowed.` The host check reads `NG_ALLOWED_HOSTS` first (`@angular/ssr/fesm2022/node.mjs:12,133`). With `NG_ALLOWED_HOSTS=localhost`, `/`, `/about`, `/posts/2`, `/posts/3` all returned 200, and `/posts/3` was SSR'd (`<h1>Post 3</h1>`; the default `fallback` for Prerender params is Server).

`ng build --output-mode static` (`evidence/build-static.log`) → `dist/angular/browser/**` + `prerendered-routes.json`, with no `server/`. Serve it with any static server.

Probe (`evidence/build-probe.log`):

```
[probe] esbuild onEnd browser errors=0
[probe] esbuild onEnd node errors=0
[probe] esbuild onEnd node errors=0
[probe] indexHtmlTransformer
Prerendered 4 static routes.
[probe] builder result {"success":true,"html":["index.csr.html","index.html","about/index.html","posts/1/index.html","posts/2/index.html"]}
```

`buildApplication`'s doc comment (`@angular/build/src/builders/application/index.d.ts`): "Usage of the `extensions` parameter is NOT supported and may cause unexpected build output or build failures. @experimental". The local builder's `schema` must be a path inside the builder package; a `../../node_modules/...` path is rejected as an "invalid builder schema path", so I copied the schema in.

# Surprises / gotchas

- **Angular rewrites the Google Fonts `<link>` into inline `<style>` at build time.** fontphobia won't find the `<link>` in built HTML; it has to parse inline `@font-face` rules pointing at `fonts.gstatic.com`, or the user has to set `optimization.fonts: false`.
- Beasties critical-CSS inlining copies fontsource `@font-face` rules into each page's `<style>` and adds `<link rel=preload as=font>`. In server mode the per-route plan sits in `angular-app-manifest.mjs` (`criticalCssPlans`, with codepoints). A rewritten woff2 name has to be updated in HTML, `styles-*.css` **and** the server manifest / `assets-chunks/*_html.mjs`.
- The `ng new --ssr` starter's `security.allowedHosts: []` makes the production server reject `localhost`. Crawling needs `NG_ALLOWED_HOSTS=localhost` (or `*`).
- Fontsource file hashing uses `-XXXXXXXX` (8 uppercase base32), under `browser/media/`.
- There's no supported plugin hook. The safest post-build step for fontphobia is to run after `ng build` (CLI wrapper) and read `prerendered-routes.json`.
