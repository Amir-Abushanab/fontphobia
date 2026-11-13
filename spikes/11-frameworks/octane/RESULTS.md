| Framework                                                                                                       | Detected by                                                                                                                                                                                                                      | Static output                                                                                                                                                                                                                                                                                                                                                                                                                                  | Server mode                                                                                                                                                                                                                                                                                              | Routes                                                                                                                                                                                                                                                                                                                                                                                                                     | Head / fonts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Plugin                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Octane 0.16.7 `fullstack` template (`@octanejs/vite-plugin` 0.5.0 + `@octanejs/app-core` 0.2.0, **Vite 8.3.5**) | `octane` dep + `@octanejs/vite-plugin` dep; **`octane.config.ts`** with `router.routes` switches it from an SPA to SSR (no config file means a plain Vite SPA). Variants: `@octanejs/rsbuild-plugin` / `@octanejs/rspack-plugin` | **No built-in prerender/SSG.** `vite build` → `dist/client/` (assets only, **no HTML**) + `dist/server/{entry.js,index.html,octane-client-build.json}`, where `index.html` is the SSR template with the markers left in. SSG means writing a script: ours (`scripts/ssg.mjs`) calls the built `handler` from `dist/server/entry.js` for each route and writes `dist/static/{index,about/index,counter/index,posts/1/index,posts/2/index}.html` | `octane-preview` (from `@octanejs/vite-plugin`, `--port`/`PORT`, default **:3000**) spawns `node dist/server/entry.js`, which serves `dist/client` statics plus streaming SSR. `/posts/3` → 200, unknown `/nope` → **404** `text/plain`. The template adds no `preview`/`start` script, so we added them | `octane.config.ts` `router.routes: [new RenderRoute({path:'/posts/:id', entry:['Post','/src/Post.tsrx']}), new ServerRoute({...})]` (Express-style `:param`). Machine list: import `octane.config.ts` in Node (native TS stripping works) → `default.router.routes[].{type,path}`. No route manifest is emitted: the plugin deletes `dist/client/.vite/manifest.json`, and `entry.js` only exports `handler`/`nodeHandler` | `index.html` `<!--ssr-head-->` takes hoisted `<title>/<meta>/<link>` from any component (React-19-style), plus the route CSS `<link>` and `modulepreload`. A stylesheet `<link>` is hoisted **only with `precedence`**, and then the Google URL comes out as `&amp;`, with `rel` reordered and `data-precedence` added. Fontsource imported in `Layout.tsrx` → chunk CSS `dist/client/assets/Layout-<hash>.css`, woff2 `dist/client/assets/inter-*-wght-normal-<hash>.woff2`, none inlined. Scoped `<style>` blocks are inlined in the body as `<style data-octane>` | `closeBundle` fires 2×: **`ssr` first, then `client` last**, because Octane runs the SSR build _inside_ its client `closeBundle`. Once the last call runs, the only HTML on disk is the marker template. Built-in post-build hook: `adapter.adapt({root,outDir,clientDir,serverDir})` in `octane.config.ts`, which runs after both bundles exist. No page HTML exists at build time unless you run your own SSG |

# Evidence

Versions: `create-octane@0.0.22` (wraps `@octanejs/cli@0.3.3` `octane create`), `octane@0.16.7`, `@octanejs/vite-plugin@0.5.0`, `@octanejs/app-core@0.2.0`, `vite@8.3.5`, `@tsrx/oxc@0.23.0` (exact peer of octane), `@tsrx/typescript-plugin@0.6.3`, `@tsrx/prettier-plugin@0.6.3`, `prettier@3.9.10`, `typescript@6.0.3` (CLI asks for `^5.9.3 || ^6.0.0`), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1, Node 24.21.0.

Scaffold: `pnpm dlx create-octane@0.0.22 octane --template fullstack --no-install --yes`.

- Without `--yes` it stops: "--yes is required when the CLI is not interactive".
- With `--no-install` it prints a "Do this by hand" list: `octane @octanejs/vite-plugin` + dev `@tsrx/typescript-plugin @tsrx/prettier-plugin prettier vite typescript@^5.9.3||^6 @tsrx/oxc@<octane's range>`. We installed those with pnpm.
- `octane@0.16.7` (published 2026-11-02) was **blocked by pnpm's minimum release age**: `pnpm add octane` silently resolved 0.16.6. It's added to `minimumReleaseAgeExclude` (`octane`, `@octanejs/*`, `@tsrx/*`) in `pnpm-workspace.yaml`. `allowBuilds: {esbuild: true}`.
- `pnpm typecheck` (`tsrx-tsc`) passes.

Fixture changes:

- `octane.config.ts`: added `/about` and `/posts/:id`.
- `src/About.tsrx`: hoisted `<title>`, plus an h1 in Fraunces.
- `src/Post.tsrx`: reads `props.params.id` (`RenderRouteProps`).
- `src/Layout.tsrx`: `import "@fontsource-variable/inter"`, hoisted preconnects and the Fraunces `<link ... precedence="default">`, and nav links.
- `styles.css`: body `"Inter Variable"`.
- Probe in `vite.config.ts`.
- `package.json` scripts: `preview: octane-preview`, `start: node dist/server/entry.js`, `ssg: node scripts/ssg.mjs`.

`pnpm build` (`evidence/build.log`):

```
vite v8.3.5 building client environment for production...
dist/client/octane-client-build.json / index.html / .vite/manifest.json
dist/client/assets/inter-{latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-wght-normal-<hash>.woff2  (10–85 kB)
dist/client/assets/index-D3sL2F6W.css        (src/styles.css, linked from index.html)
dist/client/assets/Layout-xKv10YAh.css       (fontsource @font-face, url(/assets/inter-...woff2))
dist/client/assets/{App,Counter,About,Post,Layout,octane-hydrate,forms}-<hash>.js
[@octanejs/vite-plugin] Client build done. Building the server bundle…
vite v8.3.5 building ssr environment for production...
dist/server/assets/streamed-signals-<hash>.js
dist/server/entry.js                             394.87 kB
[probe] closeBundle ssr
[@octanejs/vite-plugin] Server build complete: dist/server
[@octanejs/vite-plugin] Start with: node dist/server/entry.js (or octane-preview)
[probe] closeBundle client
```

Final tree: `dist/client/assets/*` only (index.html is **moved** to `dist/server/`, and `.vite/` is deleted), plus `dist/server/{entry.js, index.html, octane-client-build.json, assets/streamed-signals-*.js}`. `dist/server/index.html` still has `<!--ssr-head-->`, `<!--ssr-body-->` and the hydrate `<script ... nonce="__OCTANE_REQUEST_NONCE__">`; the styles.css link sits after the head marker.

Server (`evidence/preview.log`, `evidence/curl.txt`): `pnpm exec octane-preview --port 3471` prints `[octane-preview] Starting server from dist/server/entry.js` and `[octane] Production server listening on port 3471`.

```
/ 200 8296 · /about 200 3571 · /posts/1 200 3106 · /posts/3 200 3106 · /counter 200 4341
/api/health 200 application/json · /nope 404 9 text/plain
```

`/about` head (`evidence/about.html`). Hoisted elements are wrapped in `<!--rnh-<hash>-->` adoption markers:

```
<title>Octane app</title>                                  ← static, from index.html
<link rel="stylesheet" href="/assets/Layout-xKv10YAh.css"> ← route CSS (fontsource)
<link rel="modulepreload" href="/assets/About-<hash>.js">
<script id="__octane_data" type="application/json">{"entry":"/src/About.tsrx",...,"routeIndex":2,"params":{},"url":"/about",...}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap" data-precedence="default">
<title>About · Octane app</title>                          ← hoisted, so the page has 2 <title>s
<link rel="stylesheet" crossorigin href="/assets/index-D3sL2F6W.css">
```

Without `precedence`, the Fraunces stylesheet stayed in `<body>` as `<link href="...&amp;display=swap" rel="stylesheet" class="tsrx-1ea7cffb"/>` (the scoping class was stamped onto it).

SSG (`evidence/ssg.log`), run as `pnpm build && pnpm ssg`:

```
[ssg] routes [{"type":"render","path":"/"},{"type":"render","path":"/counter"},{"type":"render","path":"/about"},{"type":"render","path":"/posts/:id"},{"type":"server","path":"/api/health"}]
[ssg] 200 / -> dist/static/index.html
[ssg] 200 /counter -> dist/static/counter/index.html
[ssg] 200 /about -> dist/static/about/index.html
[ssg] 200 /posts/1 -> dist/static/posts/1/index.html
[ssg] 200 /posts/2 -> dist/static/posts/2/index.html
```

`dist/static/` = a copy of `dist/client/` plus those HTML files (the nonce attribute is stripped in handler output). The docs' route ([docs/ssr.md "Run an SSG script directly"](https://github.com/octanejs/octane/blob/main/docs/ssr.md)) is `node --import octane/compiler/register entry.ts` with `prerender()` from `octane/static`. It renders a bare component with no template, asset links or hydration, and here it **crashed**: `ERR_UNKNOWN_FILE_EXTENSION ".css"` on the fontsource import (`evidence/prerender-docs.log`). Docs on bundlers and production: https://github.com/octanejs/octane/blob/main/website/src/content/docs/build-tools.mdx.

# Surprises / gotchas

- "Fullstack" doesn't mean static: the build writes **zero page HTML**. fontphobia must either crawl the running server (`node dist/server/entry.js`, PORT) or the user must run a hand-written SSG. The docs' "SSG script" is just the renderer API, and it fails on CSS imports outside Vite.
- `closeBundle` order is inverted vs. Nuxt/others: `ssr` fires first (nested build), `client` fires **last**. Even then, only the marker template exists. Use `adapter.adapt()` for a post-build hook.
- Hoisted `<link rel=stylesheet>` needs `precedence`, and gets re-serialized (`&amp;`, attribute order, `data-precedence`), so match Google Fonts links by parsed URL, not bytes. Without `precedence` it stays in the body with a scoped `class`. A hoisted `<title>` doesn't replace the template's `<title>`, so pages get two.
- Fontsource CSS imported from a component becomes a per-chunk CSS file (`Layout-<hash>.css`) that the server links per route via the deleted Vite manifest. It's not in `dist/server/index.html`, so reading the template alone misses it.
- The route list lives only in `octane.config.ts` (class instances, `:param` syntax); there's no emitted manifest. Unknown routes return a real 404 (no SPA fallback), which helps a crawler.
- `create-octane` needs `--yes` non-interactively. pnpm's release-age gate silently downgraded `octane` to 0.16.6 until excluded.
