| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Analog 2.9.5 (Angular 22.2, Vite 8.3.5, Nitro 2.13.5) | `@analogjs/platform` dep + `analog()` in `vite.config.ts` (it also has an `angular.json`, so check this **before** Angular) | `dist/analog/public/` with directory-style `about/index.html`, `posts/1/index.html` (`analog({ prerender: { routes: [...] } })`; `static: true` for static-only). Vite intermediates go to `dist/client`, `dist/ssr` | `node dist/analog/server/index.mjs` (Nitro `node-server`, :3000, `PORT`; also in `dist/analog/nitro.json` `commands.preview`). `/posts/3` → SSR 200 | `src/app/pages/**/*.page.ts` (file-based: `about.page.ts`, `posts/[id].page.ts`). Machine list: the `prerender.routes` config, or the Nitro `prerender:done` hook (`analog({ nitro: { hooks } })`); no manifest file | Plain Vite `index.html` (Google `<link>` kept, `&`→`&amp;`; **no** Angular-CLI font inlining). Fontsource via `@import` in `src/styles.css` → `dist/analog/public/assets/index-<hash>.css`, woff2 `assets/inter-*-wght-normal-<hash>.woff2` (Vite default `[name]-[hash]`), not inlined | Real Vite plugins work: `closeBundle` 2× (`client`, `ssr`) before prerender. Post-HTML: Nitro `prerender:done` (with routes), then Nitro `close` (last) |

# Evidence

Versions: `@analogjs/platform|router|content|vite-plugin-angular@2.9.5` (npm latest; `create-analog@2.9.5`), Angular `22.2.x` (`@angular/build@22.2.5`, `compiler-cli@22.2.4`), `vite@8.3.5`, `nitropack@2.13.5`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier `create-analog` scaffold. `allowBuilds: {esbuild, @parcel/watcher, lmdb, msgpackr-extract: true}`.

Fixture:
- `index.html`: preconnect + Fraunces `<link>`.
- `src/styles.css`: `@import '@fontsource-variable/inter'`.
- `src/app/pages/about.page.ts`, `src/app/pages/posts/[id].page.ts`.
- `vite.config.ts`: `analog({ prerender: { routes: ['/', '/about', '/posts/1', '/posts/2'] }, nitro: { hooks: { 'prerender:done', close } } })` + probe plugin.

Build (`evidence/build.log`):
```
vite v8.3.5 building client environment for production...
vite v8.3.5 building ssr environment for production...      (in parallel)
✓ built in 11.53s / ✓ built in 11.54s
[probe] closeBundle client
[probe] closeBundle ssr
Prerendering static pages...
[probe] nitro prerender:done ["/","/about","/posts/1","/posts/2"]
Building Server...
[probe] nitro close
The '@analogjs/platform' server has been successfully built.
```
`dist/analog/public/`: `index.html about/index.html posts/1/index.html posts/2/index.html assets/index-BoEAPoeB.css assets/inter-*-wght-normal-<hash>.woff2 favicon.ico ...`. `dist/analog/server/index.mjs` + a pruned `node_modules/`. `dist/analog/nitro.json` has `{"preset":"node-server","framework":{"name":"nitro"},"commands":{"preview":"node server/index.mjs"}}`. Note `framework.name` is `nitro`, not analog.

Head of `about/index.html`:
```
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap">
<link rel="stylesheet" crossorigin="" href="/assets/index-BoEAPoeB.css">
<style>[_nghost-ng-c...]{...}</style>      <- component styles only
```
Server: `PORT=3013 node dist/analog/server/index.mjs` → `Listening on http://[::]:3013`. `/`, `/about`, `/posts/2`, `/posts/3`, `/api/v1/hello` all returned 200. There's no host-allowlist 400 here, unlike Angular CLI SSR.

# Surprises / gotchas
- Analog has an `angular.json`, so detection must check `@analogjs/platform` first. It builds with Vite rather than `@angular/build:application`, so none of Angular's font inlining or Beasties happens and the Google `<link>` survives.
- `nitro.json` says `framework.name: "nitro"`, so you can't identify Analog from it.
- The client and SSR Vite builds run concurrently. `closeBundle` order between `client` and `ssr` isn't guaranteed, and both run before prerender.
- Asset naming is Vite's default `[name]-[hash]` (`inter-latin-wght-normal-Dx4kXJAl.woff2`). Astro, VitePress, SvelteKit and Nuxt override it to `[name].[hash]`.
