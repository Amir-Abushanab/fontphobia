| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Vite 8.3.5 SPA (React 19.3 + TanStack Router 1.170.46 via `@tanstack/router-plugin` 1.168.48) | `vite` dep + `vite.config.*` + root `index.html`, and **no** meta-framework dep/plugin; router via the `@tanstack/react-router` dep / `tanstackRouter()` plugin | `dist/` with **only `dist/index.html`**: no prerender, every route is client-rendered from one shell | `vite preview` (:4173; `--port/--strictPort`) with SPA fallback, so every path (even `/nope`) returns 200 with the same 713-byte shell | `src/routes/**` (file-based, `posts/$id.tsx`). Machine list: **`src/routeTree.gen.ts`** (`fullPaths: '/' \| '/about' \| '/posts/$id'`); dynamic params can't be enumerated from build output, so a crawler must follow links in the rendered DOM | Root `index.html` `<head>` (Google `<link>` kept byte-for-byte, raw `&`). Fontsource imported in `src/main.tsx` → `dist/assets/index-<hash>.css`, woff2 `dist/assets/inter-*-wght-normal-<hash>.woff2` (Vite default `[name]-[hash]`), none inlined (all are larger than 4 kB) | Vite `closeBundle` fires once (`client`), after `dist/index.html` is written. For an SPA this is the last call and the final HTML exists |

# Evidence

Versions: `vite@8.3.5`, `react@19.3.1`, `@tanstack/react-router@1.170.46`, `@tanstack/router-plugin@1.168.48`, `@vitejs/plugin-react@6.1.x`, **`typescript@7.0.2`** (the scaffold's `~7.0.2`; `tsc -b` ran fine), `oxlint@1.89`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. `create-vite` latest is 9.3.3. I reused the earlier scaffold (create-vite react-ts + TanStack Router file routes, already wired: `index.html` Fraunces link, `main.tsx` fontsource import, routes `index`, `about`, `posts/$id`, probe in `vite.config.ts`). `allowBuilds: {esbuild: true}`.

Build (`evidence/build.log`):
```
$ tsc -b && vite build
vite v8.3.5 building client environment for production...
dist/index.html                                              0.71 kB
dist/assets/inter-latin-wght-normal-Dx4kXJAl.woff2          48.25 kB  (+6 other subsets)
dist/assets/index-BzqF0aK9.css                               2.03 kB
dist/assets/{routes,about,_id}-<hash>.js                    (autoCodeSplitting)
dist/assets/index-BCHvx7kw.js                              297.44 kB
✓ built in 299ms
[probe] closeBundle client
```
Head of `dist/index.html`:
```
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap" rel="stylesheet" />
<link rel="stylesheet" crossorigin href="/assets/index-BzqF0aK9.css">
```
Preview: `vite preview --port 4184 --strictPort` → `/`, `/about`, `/posts/2`, `/nope` all returned 200 with 713 bytes (the same shell).

# Surprises / gotchas
- There's nothing to crawl statically. fontphobia has to render in Chrome and follow links. 200s from the fallback make unknown routes indistinguishable from real ones, so seed from `routeTree.gen.ts` (with `$param` placeholders, so dynamic values come only from crawled links).
- `closeBundle` is a valid post-HTML hook here, and only here. An SPA's single client build writes `index.html` before `closeBundle`.
- The scaffold's TypeScript is 7.0.x (native), and `tsc -b` still works as the build pre-step.
- The router plugin regenerates `src/routeTree.gen.ts` on every build/dev; it's a source file, not build output.
