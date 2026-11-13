| Framework                                      | Detected by                            | Static output                                                                                                                                                                                                       | Server mode                                                                                | Routes                                                                                                                                                                                                                                              | Head / fonts                                                                                                                                                                                                                                         | Plugin                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Next.js 16.4.4 (App Router, Turbopack default) | `next` dep + `next.config.{ts,mjs,js}` | `output: 'export'` → `out/` (`about.html`, `posts/1.html`, flat `.html`); fails if `cacheComponents`/PPR is on. Server-mode prerendered HTML now lives in `.next/server/route-cache/APP_PAGE/<hash>/$/<route>.html` | `next start`, :3000. `/posts/3` returns 200 because PPR renders unknown params dynamically | `app/**/page.tsx`; machine list in `.next/prerender-manifest.json` `.routes` (concrete) + `.dynamicRoutes`, `.next/routes-manifest.json`, `.next/app-path-routes-manifest.json`; the adapter `onBuildComplete` gets `outputs.prerenders[].pathname` | `app/layout.tsx` JSX `<head>` (Google `<link>` kept as-is, plus an auto `<link rel=preload as=style>`); fontsource woff2 → `.next/static/media/inter-latin-wght-normal.<hash>.woff2` (copied to `out/_next/static/media/`); never inlined as `data:` | Turbopack: no bundler plugin hook. Use **adapter `onBuildComplete`** (`adapterPath` in config or the `NEXT_ADAPTER_PATH` env var, which needs no config edit), which runs once after all HTML exists. `compiler.runAfterProductionCompile` runs before prerender. Webpack (`--webpack`): `done` fires 3× (server, edge-server, client), all before prerender |

# Evidence

Versions: `next@16.4.4` (the npm `latest` on 2026-11-02), `react@19.3.0`, `react-dom@19.3.0`, `@fontsource-variable/inter@5.3.0`, `typescript@5.9.3`, pnpm 12.9.1, node 24.21.0. The scaffold came from `create-next-app` in an earlier attempt and was reused. It had the starter's `next/font/google` Geist, plus `cacheComponents: true` and `partialPrefetching: true`.

Fixture: `app/layout.tsx` imports `@fontsource-variable/inter` and puts the Fraunces `<link>` in JSX `<head>`. Routes are `/`, `/about`, and `/posts/[id]` with `generateStaticParams` → 1, 2. Config: `next.config.ts`. `FONTPHOBIA_EXPORT=1` switches to `output: 'export'` and turns off cacheComponents/PPR. `probe-adapter.mjs` is the adapter probe. A webpack `done` probe is in `webpack()`, and `compiler.runAfterProductionCompile` is also probed.

Build logs are in `evidence/`.

## Probe order (Turbopack, `next build`)

```
[probe] runAfterProductionCompile .../.next        <- after compile, BEFORE "Generating static pages"
  Generating static pages using 7 workers (8/8)
  Running onBuildComplete from probe
[probe] adapter onBuildComplete {"output":null,"outputs":{"appPages":10,"prerenders":30,"staticFiles":34,...}}
[probe] adapter prerender pathnames ["/","/index.rsc",...,"/about",...,"/posts/1",...,"/posts/2",...,"/posts/[id]",...]
$ node -e "...postbuild"                            <- npm postbuild script, last
```

Webpack (`next build --webpack`): `webpack done server server:nodejs`, `webpack done edge-server server:edge`, `webpack done client client`. All three fire before `runAfterProductionCompile` and before prerendering. The export build (`build-turbopack-export.log`) shows the adapter running after `out/` exists: `"outHtml":["404.html","_not-found.html","about.html","index.html","posts/1.html","posts/2.html"]`. A config with a `webpack` key and no `turbopack: {}` key makes the default Turbopack build exit 1.

`NEXT_ADAPTER_PATH=$PWD/probe-adapter.mjs next build`, with `adapterPath` commented out, still ran `onBuildComplete` (`evidence/build-env-adapter.log`). The config type doc says: "Path to a custom adapter module ... Can also be set via the `NEXT_ADAPTER_PATH` environment variable." `adapterPath` is top-level (not `experimental`) in 16.4.4 (`dist/server/config-schema.js:544`). It must be absolute: a relative path is resolved from `next/dist/server/config.js`.

## Output

Server mode (`.next/`): the HTML files are `.next/server/pages/{404,500}.html` and `.next/server/route-cache/APP_PAGE/<sha>/$/{index,about,posts/1,posts/2,posts/[id],_not-found,_global-error}.html`, with `.rsc`/`.meta`/`.segments` siblings. This is NOT the older `.next/server/app/*.html` layout. `.next/server/app/` now holds only JS.

Export (`out/`): `index.html about.html posts/1.html posts/2.html 404.html _not-found.html`, plus `_next/static/...`. Served with `python3 -m http.server -d out` → `/posts/1.html` returned 200.

Fonts: Turbopack writes `.next/static/media/inter-{latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-wght-normal.<13-char hash>.woff2`, referenced from `.next/static/chunks/<hash>.css` with `url(../media/...)` and fontsource's `unicode-range`. Webpack writes `.next/static/media/inter-latin-wght-normal.6c596dfc.woff2` (8-hex hash) and CSS in `static/css/<hash>.css`. There were zero `data:` URIs in the CSS. `next/font/google` (Geist, from the starter) is downloaded at build time into `static/media/<hash>-s[.p].woff2`, where `.p` means preloaded, along with a generated `Geist Fallback` face.

Google `<link>` in built HTML (export and server):

```
<link rel="preload" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap" as="style"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap"/>
```

The stylesheet is kept as-is (React hoists it and adds a `preload as=style`).

Server: `pnpm start` → `▲ Next.js 16.4.4 - Local: http://localhost:3000 ✓ Ready in 82ms`. `curl /posts/2` → 200, 8598 bytes, contains "Post 2". `/posts/3` → 200 (PPR shell plus dynamic params, with no `dynamicParams=false`).

Manifests: `.next/prerender-manifest.json` has `routes` = `["/","/_global-error","/_not-found","/about","/favicon.ico","/posts/1","/posts/2"]` and `dynamicRoutes["/posts/[id]"]` (PPR, `remainingPrerenderableParams`). `.next/routes-manifest.json` has `staticRoutes[].page` and `dynamicRoutes[].{page,regex}`. `.next/app-path-routes-manifest.json` maps `"/posts/[id]/page": "/posts/[id]"`.

# Surprises / gotchas

- The create-next-app 16.4 starter turns on `cacheComponents` + `partialPrefetching`. `output: 'export'` then fails with `Invariant: PPR cannot be enabled in export mode`.
- Server-mode HTML moved to `.next/server/route-cache/APP_PAGE/<hash>/$/...html`. Don't glob `.next/server/app`.
- Turbopack has no plugin API. The adapter API (`adapterPath` / `NEXT_ADAPTER_PATH`) is the only post-HTML hook that is the same for both bundlers. `runAfterProductionCompile` runs too early (no HTML yet).
- With webpack, `done` fires 3× (nodejs server, edge server, client), and none of those calls has the HTML.
- Turbopack and webpack hash fontsource file names differently (13-char base32 vs 8-hex).
- With PPR on, an unknown dynamic param (`/posts/3`) renders on demand (200), so a crawler can't use a 404 to detect "not prerendered".
- The starter's `next/font/google` (Geist) self-hosts Google fonts with generated fallback metrics. That is a second font pipeline next to fontsource.
