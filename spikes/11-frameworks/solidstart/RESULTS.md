| Framework                                                            | Detected by                                                                                                      | Static output                                                                                                                                                                                                                                | Server mode                                                                                                                                                         | Routes                                                                                                                                                                              | Head / fonts                                                                                                                                                                                                                                                                                                 | Plugin                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SolidStart 2.2.0 (Vite 8.3.5 + Nitro v3 `nitro/vite`, 3.0.261102-rc) | `@solidjs/start` dep + `solidStart()` (and `nitro()`) in `vite.config.ts` (v2 dropped vinxi and `app.config.ts`) | `.output/public/` with directory-style `about/index.html`, `posts/1/index.html`; enable via `nitro({ prerender: { routes, crawlLinks } })`; `preset: 'static'` for static-only. **`.output/public/.vite/manifest.json` is shipped publicly** | `node .output/server/index.mjs` (:3000, `PORT`); also `vite preview` (Nitro-aware). The command is in `.output/nitro.json` `commands.preview`. `/posts/3` → SSR 200 | `src/routes/**` (`posts/[id].tsx`, `[...404].tsx`), served by `<FileRoutes/>` (virtual module, no file). Machine list: Nitro `prerender:done` hook or the `prerender.routes` config | `src/entry-server.tsx` `document` `<head>` (or `@solidjs/meta` `<Link>`); Google `<link>` kept (`&`→`&amp;`). Fontsource imported in `app.tsx` → `.output/public/_build/assets/entry-client-<hash>.css`, woff2 `_build/assets/inter-*-wght-normal-<hash>.woff2` (Vite default `[name]-[hash]`), none inlined | Vite `closeBundle`: `client`, `ssr`, then (node-server only) **`nitro` after prerender**, so in server mode the last closeBundle sees HTML. In static mode there are only 2, both before HTML. Reliable: Nitro `prerender:done` / `close` (`nitro({hooks})`) |

# Evidence

Versions: `@solidjs/start@2.2.0` (npm latest, published 2026-11-01T23:32Z), `solid-js@1.9.18`, `@solidjs/router@1.0.1`, `@solidjs/meta@0.29.4`, `vite@8.3.5`, `nitro@3.0.261102-rc` (npm `latest`, published 2026-11-02T18:04Z), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier scaffold (SolidStart `basic` example). `pnpm-workspace.yaml` `minimumReleaseAgeExclude: ["@solidjs/start@2.2.0", "nitro@3.0.261102-rc"]`, because both are younger than pnpm 12's minimum release age.

The template pins `nitro: ^3.0.260610-beta`. A semver prerelease range only matches `3.0.260610-*`, so a plain install stays on the beta. With the beta, the server build worked, but **`preset: 'static'` crashed** after prerendering (`evidence/build-static.log`): `rolldownOptions.input should not be an html file when building for SSR. Please specify a dedicated SSR entry.` from `nitro/dist/vite.mjs:120 buildEnvironments`. Upgrading to `nitro@3.0.261102-rc` fixed it (`evidence/build-static-rc.log`).

Fixture:

- `src/entry-server.tsx` `<head>`: preconnect + Fraunces `<link>`.
- `src/app.tsx`: `import "@fontsource-variable/inter"`, nav links.
- `src/routes/posts/[id].tsx`.
- `vite.config.ts`: `nitro({ prerender: { routes: [...4], crawlLinks: false }, hooks: {compiled, 'prerender:done', close} })` + probe; `SOLID_STATIC=1` → `preset: 'static'`.

Server build (`evidence/build.log`, nitro rc):

```
[probe] closeBundle client
[probe] closeBundle ssr
[nitro] ◐ Building [Nitro] (preset: node-server, compatibility: 2026-10-28)
[probe] nitro compiled
[nitro] ℹ Prerendering 4 routes  / /about /posts/1 /posts/2
[probe] nitro prerender:done ["/","/about","/posts/1","/posts/2"]
vite v8.3.5 building nitro environment for production...
[probe] closeBundle nitro
[probe] nitro close
[probe] nitro compiled
```

Static build: the same, minus the `nitro` environment build and its `closeBundle`. Output: `.output/public/{index.html, about/index.html, posts/1/index.html, posts/2/index.html, favicon.ico, .vite/manifest.json, _build/assets/{entry-client-B3KcijO5.css,index-DPmsJEkk.css,inter-*-wght-normal-<hash>.woff2}}` and `.output/nitro.json` (`"framework":{"name":"nitro"}`, `"serverEntry":"server/index.mjs"`, `"commands":{"preview":"node ./server/index.mjs"}`; static: `"npx serve ./public"`).

Head of `about/index.html`:

```
<link rel="icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap">
<link href="/_build/assets/entry-client-B3KcijO5.css" rel="stylesheet" />
```

Server: `PORT=3014 node .output/server/index.mjs` → `➜ Listening on: http://localhost:3014/ (all interfaces)`. `/`, `/about`, `/posts/2`, `/posts/3` returned 200 (`<h1>Post <!--$-->3<!--/--></h1>`). Static: `vite preview --port 4181 --strictPort` → `/posts/2` returned 200.

# Surprises / gotchas

- SolidStart 2 runs on Nitro v3 (the `nitro` package, not `nitropack`) as a Vite plugin. The starter's beta Nitro pin breaks `preset: 'static'`, and the fix (rc) was hours old, so it needed `minimumReleaseAgeExclude`.
- `nitro.json` reports `framework.name: "nitro"`, so detection has to use package.json.
- In node-server mode the final `closeBundle` (environment `nitro`) fires after prerender. In static mode it never fires. "Last closeBundle" means different things per preset; use Nitro hooks.
- The Vite client manifest ends up public at `.output/public/.vite/manifest.json`. That's handy for fontphobia (asset map) but it is a leak.
- Intermediates live in `node_modules/.nitro/vite/services/ssr/`.
