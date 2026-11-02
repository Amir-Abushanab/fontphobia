| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Gatsby 5.16.1 (webpack 5, React 18.3.1) | `gatsby` dep + `gatsby-config.{js,ts,mjs}` | Always SSG → `public/` with directory-style `about/index.html`, `posts/1/index.html`, `404.html` + `404/index.html`, `page-data/**/page-data.json` | `gatsby serve` (static, :9000). `/about` → 301 `/about/`; `/posts/3/` → 404. (SSR/DSG pages exist via `getServerData`/`defer` but none in this fixture) | `src/pages/**` + `createPages` in `gatsby-node.js` (+ File System Route API). Machine list: **`public/page-data/<path>/page-data.json`** (one per page, includes `path`), or `store.getState().pages` in `onPostBuild` | Global head via `gatsby-ssr.js` `onRenderBody({setHeadComponents})` (or the per-page `Head` export); Google `<link>` kept (`&`→`&amp;`). Fontsource imported in `gatsby-browser.js`/`gatsby-ssr.js` → **all global CSS inlined into every page** as `<style data-href="/styles.<hash>.css" data-identity="gatsby-global-css">`, and the file is also kept; woff2 → `public/static/inter-*-wght-normal-<32hex>.woff2` | `onCreateWebpackConfig` → `compiler.hooks.done` fires 2× (`build-javascript`, `build-html`), both **before** "Building static HTML for pages". Post-HTML: the Gatsby node API **`onPostBuild`**, once |

# Evidence

Versions: `gatsby@5.16.1` (npm latest), `react@18.3.1`, `react-dom@18.3.1`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier scaffold (gatsby-starter-minimal, "A Gatsby starter with no plugins and a single welcome page").

`pnpm-workspace.yaml`:
- `allowBuilds`: lmdb, msgpackr-extract, @parcel/watcher, gatsby, gatsby-cli, @swc/core, esbuild = true; core-js, core-js-pure, sharp, es5-ext = false.
- The first install failed with `ERR_PNPM_IGNORED_BUILDS: es5-ext@0.10.64`. pnpm 12 errors (it doesn't warn) on unlisted build scripts.
- **`nodeLinker: hoisted`** is required (see below).

The first build used pnpm's default isolated linker and failed 12× with `ERROR #98124 WEBPACK.BUILD-JAVASCRIPT ... Can't resolve '@gatsbyjs/reach-router' | 'gatsby-link' | 'prop-types' | 'gatsby-react-router-scroll' in '.../gatsby/.cache'` (`evidence/build-isolated-linker-fail.log`). It worked after `nodeLinker: hoisted` and a reinstall.

Fixture:
- `gatsby-ssr.js`: `onRenderBody` `setHeadComponents([preconnect, Fraunces <link>])` + fontsource import.
- `gatsby-browser.js`: `import "@fontsource-variable/inter"`.
- `src/pages/about.js`.
- `gatsby-node.js`: `createPages` → `/posts/1/`, `/posts/2/` from `src/templates/post.js`; `onCreateWebpackConfig` `done` probe; `onPostBuild` probe.

Build (`evidence/build.log`, ANSI stripped):
```
[probe] webpack done build-javascript build-javascript
success Building production JavaScript and CSS bundles - 2.820s
[probe] webpack done build-html build-html
success Building HTML renderer - 2.893s
success Building static HTML for pages - 2.607s - 6/6 2.30/s
[probe] onPostBuild /Users/amir/Code/fontphobia/spikes/11-frameworks/gatsby
["/posts/1/","/posts/2/","/404/","/404.html","/about/","/"]
success onPostBuild - 0.008s
```
`public/`: `index.html, about/index.html, posts/{1,2}/index.html, 404.html, 404/index.html, styles.322f24c2a020111cdded.css, static/inter-latin-wght-normal-4f2981d82860061bca3ecb967a2cd084.woff2 (×7 subsets), page-data/..., chunk-map.json, webpack.stats.json, _gatsby/slices/_gatsby-scripts-1.html, ~partytown/`.

Head of `about/index.html`:
```
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap"/>
<style data-href="/styles.322f24c2a020111cdded.css" data-identity="gatsby-global-css">@font-face{font-display:swap;font-family:Inter Variable;...src:url(/static/inter-cyrillic-ext-wght-normal-b5cdd4765614e027c252bcbea138906e.woff2) format("woff2-variations")...</style>
```
There's no `<link>` to the CSS file and no `data:` URIs in it.

Serve: `pnpm serve` → `http://localhost:9000/`. `/` 200, `/about/` 200, `/about` 301, `/posts/2/` 200, `/posts/3/` 404.

# Surprises / gotchas
- **Gatsby doesn't work with pnpm's default linker.** `nodeLinker: hoisted` is mandatory, and the error is an opaque webpack resolve failure in `.cache/`.
- Gatsby inlines *all* global CSS (including every fontsource `@font-face`) into every HTML page, keyed by `data-href`. Rewriting woff2 URLs means changing every HTML file plus `styles.<hash>.css` (used on client navigation).
- `webpack.stats.json` and `chunk-map.json` are published in `public/`.
- `onCreateWebpackConfig` runs per stage; `done` fires once per stage (`build-javascript`, `build-html`), never after HTML generation.
- Fontsource woff2 names use a `-<32 hex md5>` suffix under `public/static/`, like Docusaurus and unlike Vite.
- Gatsby 5.16 is still on React 18 and webpack 5, and the project is in maintenance mode.
