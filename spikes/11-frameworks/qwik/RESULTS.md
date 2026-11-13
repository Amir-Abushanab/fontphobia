| Framework                                                                                           | Detected by                                                                                                                                     | Static output                                                                                                                                                                                                                       | Server mode                                                                                                                                                                                                                                                                                   | Routes                                                                                                                                                                                          | Head / fonts                                                                                                                                                                                                                                                                                                                                                     | Plugin                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwik 1.20.3 + Qwik City (Vite **7.3.1**, pinned by the starter; Qwik 2 is `@qwik.dev/*` 2.0.0-rc.4) | `@builder.io/qwik` + `@builder.io/qwik-city` devDeps + `qwikCity()`/`qwikVite()` in `vite.config.ts` (v2: `@qwik.dev/core`, `@qwik.dev/router`) | Needs an adapter: `qwik add static` → `adapters/static/vite.config.ts` (`staticAdapter({origin})`); `qwik build` → `dist/` with directory-style `about/index.html`, `posts/1/index.html` + `q-data.json`, `404.html`, `sitemap.xml` | Without a server adapter: `qwik build preview` + `vite preview` (SSR via `src/entry.preview.tsx`, :4173). Plain `vite preview` after a static build returns **400** for every route. Real servers need `qwik add express\|fastify\|node-server...` (docs only here). `/about` → 301 `/about/` | `src/routes/**/index.tsx` (directory-based; `posts/[id]/index.tsx` + `onStaticGenerate`). Machine list: `dist/sitemap.xml` (static adapter, uses `origin`); `server/@qwik-city-static-paths.js` | `src/components/router-head/router-head.tsx` (+ route `head` exports); Google `<link>` kept (`&`→`&amp;`, adds `q:head`). Fontsource CSS **inlined as `<style>`** in every page; woff2 in `dist/assets/<hash>-inter-*-wght-normal.woff2` (**hash first**). Qwik also injects `<link rel=preload as=font>` for **all 7** subsets (`q-manifest.json` `injections`) | `qwik build` runs several Vite builds: `closeBundle` 1× per build (`client`, then `ssr` for the adapter). SSG runs inside the adapter plugin's own `closeBundle` (`vite-plugin-qwik-city-static-generate`), in parallel with the probe, so no reliable post-HTML Vite hook. Run after `qwik build` |

# Evidence

Versions: `@builder.io/qwik@1.20.3`, `@builder.io/qwik-city@1.20.3` (npm latest; `create-qwik@1.20.3`), the starter's pinned `vite@7.3.1`, `typescript@5.4.5`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier "empty" starter scaffold. `allowBuilds: {esbuild: true, sharp: true, "@parcel/watcher": false}`. Adapter: `pnpm qwik add static --skipConfirmation=true` (non-interactive) created `adapters/static/vite.config.ts` and the `build.server` script; I set `origin` to `https://example.com`.

Fixture:

- `router-head.tsx`: preconnect + Fraunces `<link>`.
- `root.tsx`: `import "@fontsource-variable/inter"`; nav.
- `src/routes/about/index.tsx`, `src/routes/posts/[id]/index.tsx` (`onStaticGenerate → [{id:'1'},{id:'2'}]`).
- `vite.config.ts`: probe (logs `process.argv` to tell the sub-builds apart).

`pnpm build` = `qwik build` → `build.types`, `build.client` (`vite build`), `build.server` (`qwik check-client src dist && vite build -c adapters/static/vite.config.ts`), `lint`, run as separate processes (`evidence/build-static.log`):

```
[probe] closeBundle client build
[probe] closeBundle ssr build -c adapters/static/vite.config.ts
Starting Qwik City SSG...
dist/posts/2/index.html  dist/index.html  dist/about/index.html  dist/posts/1/index.html
SSG results - Generated: 4 pages
```

`dist/`: `index.html, 404.html, about/index.html, about/q-data.json, posts/{1,2}/index.html, posts/{1,2}/q-data.json, q-manifest.json, sitemap.xml, manifest.json, assets/CJtQP8FK-style.css, assets/DClvBTIT-bundle-graph.json, assets/Dx4kXJAl-inter-latin-wght-normal.woff2 ...`.

Head of `about/index.html`:

```
<link rel="preconnect" href="https://fonts.googleapis.com" q:head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap" q:head>
<link rel="preload" href="/assets/Dx4kXJAl-inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
... (same for latin-ext, vietnamese, greek, greek-ext, cyrillic, cyrillic-ext)
<style ...>@font-face{font-family:Inter Variable;...src:url(/assets/BOeWTOD4-inter-cyrillic-ext-wght-normal.woff2)...}</style>   (2030 B, all fontsource faces)
```

`assets/CJtQP8FK-style.css` is emitted but not linked, because its contents are inlined. The preloads come from `q-manifest.json` `injections: [{tag:"link", location:"head", attributes:{rel:"preload", href:"/assets/...woff2", as:"font"}} ×7]`.

`dist/sitemap.xml` lists `https://example.com/{posts/2/, , about/, posts/1/}`.

Serving:

- `vite preview` right after the static build prints `Please ensure "src/entry.preview.tsx" has been built before the "preview" command.`, and every route returns 400.
- `pnpm qwik build preview` (`evidence/build-preview.log`: `closeBundle client`, `closeBundle ssr build --ssr src/entry.preview.tsx`), then `vite preview --port 4183 --strictPort` → `/`, `/about/`, `/posts/2/`, `/posts/3/` returned 200 (SSR `Post <!--t=6-->3`), and `/about` returned 301.

# Surprises / gotchas

- Qwik preloads **every** fontsource woff2 subset on every page (7 preloads for one family), using `q-manifest.json` injections. fontphobia has to rewrite those preload links and the manifest.
- Asset file names put the hash first: `Dx4kXJAl-inter-latin-wght-normal.woff2`. The hash is the same as Vite's but at the start.
- Fontsource CSS is inlined into `<style>` in each page, and an unreferenced `style.css` copy remains.
- `qwik build` is a multi-process orchestrator: each Vite build is its own process, `closeBundle` fires once per process, and SSG runs in a parallel `closeBundle` of the static adapter. Treat `qwik build`'s exit as the hook.
- With no server adapter, the production server is `vite preview` after `qwik build preview`. A static-only build can't be previewed with `vite preview`; use any static file server.
- Trailing-slash URLs (`/about/`) are canonical, and `/about` redirects.
- The starter pins Vite 7.3.1 (not 8) and TS 5.4.5.
