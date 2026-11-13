| Framework                                       | Detected by                                                                              | Static output                                                                                                                                                                                               | Server mode                                                                                                                                                                         | Routes                                                                                                                                                                                                              | Head / fonts                                                                                                                                                                                                                                                                                                               | Plugin                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Router 8.5.1 (framework mode, Vite 8.3.5) | `@react-router/dev` dep + `react-router.config.ts` + `reactRouter()` in `vite.config.ts` | `build/client/` with directory-style `about/index.html`, `posts/1/index.html` + `posts/1.data`; enable via config `prerender: [paths]` (or `true`, or an async fn). `ssr: false` adds `__spa-fallback.html` | `react-router-serve ./build/server/index.js` (the `start` script, :3000, `PORT`). **`/about` → 301 to `/about/`** (express static serves the prerendered dir); `/posts/3` → SSR 200 | `app/routes.ts` (config-based `RouteConfig`; file-based only with `flatRoutes()`). Machine list: **`react-router routes --json`** (route tree JSON); also generated `.react-router/types/+routes.ts` (`Pages` type) | Root `links()` export in `app/root.tsx` + `<Links/>` (Google `<link>` kept, `&`→`&amp;`). **The starter already ships a Google Fonts `<link>` (Inter) plus preconnects.** Fontsource → `build/client/assets/root-<hash>.css`, woff2 `assets/inter-*-wght-normal-<hash>.woff2` (Vite default `[name]-[hash]`), none inlined | Vite `closeBundle` 4× (`client`, `ssr`, `ssr`, `client`), all before prerender. Post-HTML: config hook **`buildEnd({ buildManifest, reactRouterConfig, viteConfig })`**, once, after prerender |

# Evidence

Versions: `react-router|@react-router/dev|@react-router/node|@react-router/serve@8.5.1` (npm latest; `create-react-router@8.5.1`), `react@19.x`, `vite@8.3.5`, `tailwindcss@4`, `typescript@5.9.3`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. I reused the earlier `create-react-router` scaffold (default template); its `pnpm-workspace.yaml` is `packages: [.]` and no build scripts were needed.

Fixture:

- `app/root.tsx`: `import "@fontsource-variable/inter"`; the starter's Google Inter stylesheet in `links()` is replaced with Fraunces (the preconnects are kept); nav.
- `app/routes.ts`: `index(home)`, `route("about")`, `route("posts/:id")` (with a `loader`).
- `react-router.config.ts`: `prerender: ["/", "/about", "/posts/1", "/posts/2"]` + `buildEnd` probe; `RR_SPA=1` → `ssr: false`.
- `vite.config.ts`: probe plugin.

SSR build (`evidence/build-ssr.log`):

```
vite v8.3.5 building client environment for production...
[probe] closeBundle client
vite v8.3.5 building ssr environment for production...
✓ 10 assets cleaned from React Router server build.
[probe] closeBundle ssr
[probe] closeBundle ssr
[probe] closeBundle client
Prerender (html): / -> build/client/index.html
Prerender (html): /about -> build/client/about/index.html
Prerender (data): /posts/1 -> build/client/posts/1.data
Prerender (html): /posts/1 -> build/client/posts/1/index.html
...
[probe] buildEnd .../react-router/build ssr=true
```

SPA build (`RR_SPA=1`, `evidence/build-spa.log`): the same, plus `Prerender (html): SPA Fallback -> build/client/__spa-fallback.html`. `build/server/index.js` is still emitted.

Head of `about/index.html`:

```
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/>
<link rel="stylesheet" href="/assets/root-DN5FfG9l.css"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap"/>
```

Server: `PORT=3016 pnpm start` → `[react-router-serve] http://localhost:3016`. `/` 200; `/about` and `/posts/2` 301 → `Location: /about/`, after which `/about/` returns 200; `/posts/3` 200 (SSR `<h1>Post <!-- -->3`).

`pnpm exec react-router routes --json`:

```
[{"id":"root","path":"","file":"root.tsx","children":[{"id":"routes/home","index":true,"file":"routes/home.tsx"},{"id":"routes/about","path":"about","file":"routes/about.tsx"},{"id":"routes/post","path":"posts/:id","file":"routes/post.tsx"}]}]
```

# Surprises / gotchas

- The default starter already uses Google Fonts (Inter) via `links()`, with preconnects to `fonts.googleapis.com` and `fonts.gstatic.com`. Every fresh RR app is a fontphobia candidate.
- `react-router-serve` 301-redirects prerendered routes to a trailing slash, because express.static finds the `about/` directory first. Crawl with redirects followed and normalize URLs.
- Prerendering also writes `.data` files (turbo-stream loader data) next to the HTML.
- `closeBundle` fires 4×, and the order (client, ssr, ssr, client) includes extra builds the RR plugin does internally. None of them sees HTML; `buildEnd` does.
- `react-router routes --json` is the best machine-readable route source of any framework here.
