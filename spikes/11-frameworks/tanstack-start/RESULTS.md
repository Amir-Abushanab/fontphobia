| Framework                                                                     | Detected by                                                                                      | Static output                                                                                                                                                                                                             | Server mode                                                                                                                                                                                                                                                                                                                                                  | Routes                                                                                                                                                                                                                            | Head / fonts                                                                                                                                                                                                                                                                                                                                                   | Plugin                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TanStack Start 1.169.4 (React, `@tanstack/react-router` 1.170.46, Vite 8.3.5) | `@tanstack/react-start` (or `@tanstack/solid-start`) dep + `tanstackStart()` in `vite.config.ts` | `dist/client/` with directory-style `about/index.html`, `posts/1/index.html`, via `tanstackStart({ prerender: { enabled: true, crawlLinks }, pages: [{path}] })`. `/posts/3` is not prerendered but the server renders it | `dist/server/server.js` is only a **fetch handler** (`export default {fetch}`), so `node` on it exits immediately. Run it with `vite preview` (:4173), or `srvx serve --prod --entry ./dist/server/server.js --static ../client` (:3000; srvx is a transitive dep; `--static` resolves relative to the entry dir), or add the Nitro plugin for a node server | `src/routes/**` (`posts/$id.tsx`). Machine list: **`src/routeTree.gen.ts`** (generated TS; `FileRoutesByFullPath` / `fullPaths: '/' \| '/about' \| '/posts/$id'`); prerendered list in the `[prerender] Prerendered 4 pages:` log | Root route `head: () => ({ links: [...] })` in `src/routes/__root.tsx` + `<HeadContent/>`; the Google `<link>` is kept but React 19 hoists stylesheets (`data-precedence="default"`) ahead of the preconnect. Fontsource → `dist/client/assets/index-<hash>.css`, woff2 `assets/inter-*-wght-normal-<hash>.woff2` (Vite default `[name]-[hash]`), none inlined | Vite `closeBundle` 2× (`client`, `ssr`); prerender runs **after** both, with no Vite hook later. Post-HTML: none built in. Run after `vite build`, or add a plugin whose `buildApp` hook is ordered after Start's |

# Evidence

Versions: `@tanstack/react-start@1.169.4`, `@tanstack/react-router@1.170.46`, `@tanstack/react-router-devtools@1.167.2`, `@tanstack/devtools-vite@0.8.6`, `react@19.3.1`, `vite@8.3.5`, `@vitejs/plugin-react@6`, `tailwindcss@4`, `srvx@1.0.8` (transitive), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. `@tanstack/cli` latest is 0.72.9. I reused the earlier scaffold (`.cta.json`: file-router, tailwind, `projectPreset: default`). `allowBuilds: {esbuild: true, lightningcss: true}`.

Fixture:

- `src/routes/__root.tsx`: `import '@fontsource-variable/inter'`; `head().links` gets the preconnect + Fraunces stylesheet; nav.
- `src/routes/about.tsx`, `src/routes/posts/$id.tsx`.
- `vite.config.ts`: `tanstackStart({ prerender: { enabled: true, crawlLinks: false }, pages: [/, /about, /posts/1, /posts/2] })` + probe.

Build (`evidence/build.log`):

```
vite v8.3.5 building client environment for production...  ✓ built
[probe] closeBundle client
vite v8.3.5 building ssr environment for production...     ✓ built
[probe] closeBundle ssr
[prerender] Prerendering pages...
[prerender] Concurrency: 12
[prerender] Crawling: / ... /posts/2
[prerender] Prerendered 4 pages:
[prerender] - /  - /about  - /posts/2  - /posts/1
```

Output: `dist/client/{index.html,about/index.html,posts/1/index.html,posts/2/index.html,assets/styles-CmCcBo5l.css,assets/index-xKv10YAh.css,assets/inter-*-wght-normal-<hash>.woff2}`, `dist/server/server.js`.

Head of `about/index.html` (in this order):

```
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap" data-precedence="default"/>
<link rel="stylesheet" href="/assets/styles-CmCcBo5l.css" data-precedence="default"/>
<link rel="stylesheet" href="/assets/index-xKv10YAh.css" data-precedence="default"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
```

Server:

- `node dist/server/server.js` → exits 0 at once (the file ends `var server_default = createServerEntry({ fetch }); export { createServerEntry, server_default as default };`).
- `vite preview --port 4182 --strictPort` → `/`, `/about`, `/posts/2`, `/posts/3` returned 200.
- `node .../srvx/bin/srvx.mjs serve --prod --entry ./dist/server/server.js --static ../client --port 3015` → `➜ Listening on: http://localhost:3015/`; all routes and `/assets/index-xKv10YAh.css` returned 200. `--static ./dist/client` failed with `--static directory not found: .../dist/server/dist/client`.

Routes: `src/routeTree.gen.ts` is regenerated by the router plugin on build/dev:

```
export interface FileRoutesByFullPath { '/': typeof IndexRoute; '/about': typeof AboutRoute; '/posts/$id': typeof PostsIdRoute }
fullPaths: '/' | '/about' | '/posts/$id'
```

# Surprises / gotchas

- There is no production server command out of the box. The server build is a WinterCG fetch handler, so fontphobia needs to use `vite preview`, srvx, or Nitro, or crawl `dist/client` statically.
- Prerendering runs after the last `closeBundle`, so no closeBundle call sees HTML.
- React 19 reorders `<link rel=stylesheet>` by precedence, which puts the Google CSS above the `preconnect`. Its href is unchanged.
- The devtools Vite plugin strips devtools code from `__root.tsx` in production builds (it logs this).
- Dynamic params use `$id` filenames (not `[id]`). The route tree uses `$id` too, so map `$param` to concrete paths from the prerender pages list.
