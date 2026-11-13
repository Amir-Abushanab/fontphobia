| Framework                                                                               | Detected by                                              | Static output                                                                                                                  | Server mode                                        | Routes                                                                                                                                                                                                            | Head / fonts                                                                                                                                                                                                                                                                                       | Plugin                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docusaurus 3.10.2 (classic, `future.v4: true` → Rspack 1.7.12 via `@docusaurus/faster`) | `@docusaurus/core` dep + `docusaurus.config.{ts,js,mjs}` | Always SSG → `build/` with directory-style `posts/1/index.html` + `404.html`, `sitemap.xml`; HTML is minified (unquoted attrs) | No server mode. `docusaurus serve` (static, :3000) | `docs/`, `blog/`, `src/pages/` + plugin `actions.addRoute()`. Machine list: `postBuild({routesPaths})` (30 paths incl. `/posts/1`, `/404.html`); also `.docusaurus/routes.js` (JS module) and `build/sitemap.xml` | Config `stylesheets: [{href}]` / `headTags` (Google `<link>` kept, raw `&`, attrs unquoted where possible); fontsource via `@import` in `src/css/custom.css` → bundled into `build/assets/css/styles.<8hex>.css`, woff2 → `build/assets/fonts/inter-latin-wght-normal-<32hex>.woff2`, none inlined | Rspack/webpack `compiler.hooks.done` via plugin `configureWebpack`: fires 2× (`server`, then `client`), **before** SSG. Docusaurus plugin lifecycle `postBuild({outDir, routesPaths})`: once, after all HTML exists |

# Evidence

Scaffold: `pnpm dlx create-docusaurus@3.10.2 docusaurus classic --typescript --package-manager pnpm --skip-install`. Versions: `@docusaurus/core|preset-classic|faster@3.10.2`, `react@19.x`, `typescript@6.0.3`, `@rspack/core@1.7.12` (webpack 5.112.2 is also installed), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. `pnpm-workspace.yaml` `allowBuilds: {core-js: false, "@swc/core": true}`. There were no release-age blocks.

The starter has `future: { v4: true }`. `DEFAULT_FUTURE_V4_CONFIG_TRUE.fasterByDefault: true` turns on `faster.rspackBundler: true` and the SWC loaders and minifiers (`node_modules/@docusaurus/core/lib/server/configValidation.js:61-86`). So a fresh starter builds with **Rspack**, not webpack.

Fixture (`docusaurus.config.ts`):

- `stylesheets: [{href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap'}]` plus a `headTags` preconnect.
- An inline plugin `probePlugin`:
  - `contentLoaded` → `actions.addRoute` for `/posts/1`, `/posts/2` (component `src/components/Post/index.tsx`). This is the Docusaurus equivalent of a dynamic route.
  - `configureWebpack` → `compiler.hooks.done` probe.
  - `postBuild` probe.
- `src/css/custom.css` starts with `@import "@fontsource-variable/inter";` and sets `--ifm-font-family-base`.

Build (`evidence/build.log`):

```
[INFO] [en] Creating an optimized production build...
[probe] compiler done server server
[probe] compiler done client client
[probe] postBuild .../docusaurus/build/ ["/404.html","/blog",...,"/markdown-page","/posts/1","/posts/2","/docs/intro",...,"/"]
[SUCCESS] Generated static files in "build".
```

Output has 30 HTML files, including `build/index.html`, `build/404.html`, `build/posts/{1,2}/index.html`, `build/docs/intro/index.html`, and `build/sitemap.xml`. CSS is a single `build/assets/css/styles.c27428ee.css` with `src:url(/assets/fonts/inter-latin-wght-normal-4f2981d82860061bca3ecb967a2cd084.woff2)`. All 7 subsets are in `build/assets/fonts/`, and there are no `data:` URIs in the CSS.

Head of `posts/1/index.html`:

```
<link rel=preconnect href=https://fonts.googleapis.com>
<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap">
<link rel=stylesheet href=/assets/css/styles.c27428ee.css />
```

Serve: `pnpm serve --no-open` → `[SUCCESS] Serving "build" directory at: http://localhost:3000/`. `curl /posts/2` → 200, `<h1>Post <!-- -->2`.

Generated (not output): `.docusaurus/{routes.js, routesChunkNames.json, client-manifest.json, globalData.json, ...}`.

# Surprises / gotchas

- The default starter now builds with Rspack (via `future.v4: true` → `fasterByDefault`). The `configureWebpack` / `compiler.hooks.done` API still works because Rspack is compatible. HTML minification (`@swc/html`) strips attribute quotes, so HTML parsing must not depend on quotes.
- Fontsource woff2 go to `assets/fonts/` with a 32-hex md5 hash joined by `-`, unlike Vite's 8-char base64url hash.
- Docusaurus has no file-based `[param]` pages that prerender multiple paths. Dynamic routes come from plugin `addRoute` (or content plugins).
- `postBuild` is the right hook: it runs once with `outDir` and every `routesPaths` (a better list than sitemap.xml, which needs `url` and skips 404).
- Node 24 prints `ExperimentalWarning: localStorage is not available` during SSG. It's harmless.
