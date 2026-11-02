| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Foldkit 0.170.0 (`create-foldkit-app` 0.41.0, `@foldkit/vite-plugin` 0.29.0, Effect 4.1.0, **Vite 8.3.5**), scaffolded with `--rendering ssg` | `foldkit` dep + `@foldkit/vite-plugin` dep (`foldkit()` in `vite.config.*`). The mode comes from the plugin options: no `ssr` = **SPA** (plain Vite SPA with root `index.html`, i.e. the existing "Vite SPA" profile); `ssr.build: {prerender: true}` = SSG; `ssr.build: true` = SSR. SSG/SSR have **no `index.html`** and use `src/entry.server.ts` instead | `vite build` → `dist/client/{index,about/index,posts/1/index,posts/2/index}.html` + `assets/`, and `dist/server/{fetch.js,foldkit.build.json}`. Prerender is enabled by `foldkit({ssr:{serverEntry,clientEntry,build:{prerender:true}}})`. Paths come from the `prerenderPaths` export of the server entry (or `build.prerender.paths`) | `vite preview --outDir dist/client` (template's `preview`, :4173) serves the files, but **`/about` (no slash) gets the SPA fallback (home page)**; only `/about/` serves `about/index.html`. Real server: `node scripts/serve.ts` (SSR template's `start`, `@foldkit/node` `Node.serve`, `PORT` default **:3000**) serves the generated files plus SSR fallback via `dist/server/fetch.js`. `/posts/3` renders, `/nope` → 200 "Not Found" page | Code only: parser combinators in `src/route.ts` (`pipe(literal('posts'), slash(int('id')), Route.mapTo(AppRoute.Post))`) and no file routes. Machine list: **`dist/server/foldkit.build.json`** `{"schemaVersion":1,"client":"dist/client","server":"dist/server","serverEntry":"fetch.js","prerendered":["/","/about","/posts/1","/posts/2"]}`; source list is `prerenderPaths` in `src/entry.server.ts` | SSG/SSR: the server entry's `renderDocument` export → `Server.renderDocument(app, assets, { head: '<link ...>' })` (trusted string, written byte-for-byte, raw `&`). `<title>`/`lang` come from `view`'s `Document`. SPA: root `index.html`. Fontsource is imported in the client entry `src/entry.ts` → `dist/client/assets/app-<hash>.css` (merged with Tailwind), woff2 `assets/inter-*-wght-normal-<hash>.woff2`, none inlined | `closeBundle` fires 2× (`client`, then `ssr`), **before** pages exist. Pages are written in Foldkit's plugin **`buildApp` hook (`order:'post'`)**. A user plugin's `buildApp: {order:'post'}` listed after `foldkit()` runs after all HTML and `foldkit.build.json` exist (verified) |

# Evidence

Versions: `create-foldkit-app@0.41.0`, `foldkit@0.170.0`, `@foldkit/vite-plugin@0.29.0`, `@foldkit/devtools@0.170.0`, `@foldkit/node@0.2.0` (added for `start`), `effect@4.1.0`, `@effect/platform-browser@4.1.0`, `@effect/platform-node@4.1.0`, `vite@8.3.5`, `tailwindcss@4.3.3` + `@tailwindcss/vite`, `typescript@7.0.2`, `vitest@5.0.5`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. Official starter: https://github.com/foldkit/foldkit/tree/main/packages/create-foldkit-app (npm `create-foldkit` 0.0.1 is a reserved-name placeholder pointing to `create-foldkit-app`).

Scaffold: `pnpm dlx create-foldkit-app@0.41.0 --name foldkit --rendering ssg --package-manager pnpm`.
- With all flags it runs fully non-interactively and installs dependencies itself.
- It writes its own `pnpm-workspace.yaml` (`allowBuilds: {msgpackr-extract: false}`). No release-age exclusions or extra `allowBuilds` were needed.
- We added `packageManager`.
- `pnpm typecheck` passes.

The three rendering modes are from `templates/rendering/{ssg,ssr}` and `templates/base` in the repo:
- `spa`: `index.html` (`<link href="/src/styles.css">`, `<div id="root">`, `<script src="./src/entry.ts">`), `vite.config.ts` = `plugins: [tailwindcss(), foldkit()]`, scripts `dev/build/preview` = vite. This is a plain Vite SPA; `foldkit()` only adds state-preserving HMR and devtools.
- `ssg`: `foldkit({ssr: {serverEntry: '/src/entry.server.ts', clientEntry: '/src/entry.ts', build: {prerender: true}}})`, `preview: vite preview --outDir dist/client`.
- `ssr`: the same with `build: true`, plus `start: node scripts/serve.ts` (`@foldkit/node` `Node.serve({port: PORT ?? 3000, origin: ORIGIN})`).
- The server API is `foldkit/experimental` (`Server.renderToString`, `Server.renderDocument`, `Server.Rendered`), marked experimental.

Fixture changes:
- `src/route.ts`: `Post: {id: Schema.Number}` + `postRouter`.
- `src/main.ts`: Post view (h1 `font-[Fraunces]`), title, nav links.
- `src/entry.server.ts`: `renderDocument` passes `head` (preconnects + Fraunces), and `prerenderPaths: ['/', '/about', '/posts/1', '/posts/2']`.
- `src/entry.ts`: `import '@fontsource-variable/inter'`.
- `styles.css`: `@theme { --font-sans: 'Inter Variable', ... }`.
- `vite.config.ts`: probe (`closeBundle` + `buildApp {order:'post'}`).
- `scripts/serve.ts`: copied from the SSR template, wired as `start`.

`pnpm build` (`evidence/build.log`):
```
vite v8.3.5 building client environment for production...
dist/client/assets/inter-{vietnamese,greek-ext,cyrillic,greek,cyrillic-ext,latin,latin-ext}-wght-normal-<hash>.woff2  10–85 kB
dist/client/assets/app-BmYWDFx2.css     8.06 kB
dist/client/assets/app-<hash>.js      305.43 kB
[probe] closeBundle client
vite v8.3.5 building ssr environment for production...
dist/server/fetch.js  570.73 kB
[probe] closeBundle ssr
  generated /
  generated /about
  generated /posts/1
  generated /posts/2
  wrote foldkit.build.json
[probe] buildApp post, posts/2 html exists: true
```
`dist/server/fetch.js` exports `default` (fetch handler), `prerenderPaths`, `renderDocument`, `renderPage`. Foldkit's generation step is in `node_modules/@foldkit/vite-plugin/dist/build.js` (`buildApp: {order: 'post', handler: finalize}`). It refuses a stray `dist/client/index.html` or an HTML Rollup input.

`dist/client/posts/2/index.html`:
```
<head><meta charset="UTF-8"><meta name="viewport" ...><title>Post 2 | Foldkit App</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap" rel="stylesheet">
<link rel="stylesheet" crossorigin href="/assets/app-BmYWDFx2.css">
</head><body><main ... data-foldkit-app="app" data-foldkit-build="<uuid>">...<h1 class="font-[Fraunces] ...">Post 2</h1>...</main>
<script type="module" crossorigin src="/assets/app-<hash>.js"></script>
```
`app-*.css` has `@font-face{font-family:Inter Variable;...src:url(/assets/inter-...woff2)...}`, with 0 `data:font` URIs.

`pnpm preview --port 4191 --strictPort` (`evidence/curl.txt`):
- `/`, `/about`, `/posts/1`, `/posts/2`, `/posts/3`, `/nope` all → 200, 1278 bytes, `<title>Home | Foldkit App</title>`.
- `/about/` → About (1220 bytes), and `/posts/2/` → Post 2.

`PORT=3192 node scripts/serve.ts` (`evidence/curl-start.txt`, `INFO Listening on http://[::]:3192`):
- `/about` and `/about/` → About, `/posts/2` → Post 2.
- `/posts/3` → "Post 3" (SSR fallback).
- `/nope` → 200 "Not Found | Foldkit App".

# Surprises / gotchas
- Foldkit isn't SPA-only: one CLI offers `spa` | `ssg` | `ssr`. Only `spa` maps to the "Vite SPA" profile. SSG/SSR have no `index.html`; the document is built in TS by `renderDocument`.
- `vite preview` on the SSG output serves the **home page for `/about`** (observed: without a trailing slash Vite's SPA fallback answers instead of `about/index.html`). A crawler using the template's own `preview` would subset against the wrong page. Read `foldkit.build.json` + files, or use `@foldkit/node`.
- `closeBundle` is too early. The only post-HTML hook is Vite's plugin-level `buildApp` with `order: 'post'` (Vite ≥7 environment API).
- Unknown routes return 200 (the template's `renderPage` never sets `status: 404` for `NotFound`), so status codes can't separate real routes from misses.
- Routes are runtime parser combinators; there's no static route list except `prerenderPaths` / `foldkit.build.json`.
- Head is a raw trusted string, so the Google `<link>` survives byte-for-byte. The server API is all `foldkit/experimental`.
