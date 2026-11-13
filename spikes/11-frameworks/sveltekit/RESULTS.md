| Framework                                   | Detected by                                                                                                                       | Static output                                                                                                                                                                                                                                                 | Server mode                                                                                                                                                                                              | Routes                                                                                                                                                                                               | Head / fonts                                                                                                                                                                                                                                                                                                  | Plugin                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SvelteKit 3.1.1 (Svelte 5.57.3, Vite 8.3.5) | `@sveltejs/kit` dep + `sveltekit()` in `vite.config.ts` (**Kit 3 has no `svelte.config.js`**; the config is the plugin's options) | adapter-static → `build/` with flat `about.html`, `posts/1.html` (`trailingSlash: 'never'` default); prerender via `export const prerender = true` in `+layout.ts`, and `entries()` for dynamic params. Intermediate: `.svelte-kit/output/prerendered/pages/` | adapter-node → `node build` (:3000, `PORT`/`HOST`); prerendered pages in `build/prerendered/`, assets in `build/client/`. Static: `vite preview` (:4173, moves to the next port if busy; `--strictPort`) | `src/routes/**/+page.svelte`. Machine list: `builder.prerendered.paths` in adapter `adapt()`; `.svelte-kit/output/server/manifest-full.js` (JS module; route ids `"/"`, `"/about"`, `"/posts/[id]"`) | `<svelte:head>` in `src/routes/+layout.svelte`, plus `src/app.html` (`%sveltekit.head%`); Google `<link>` kept (`&`→`&amp;`). Fontsource CSS → `_app/immutable/assets/0.<hash>.css`, woff2 `_app/immutable/assets/inter-*-wght-normal.<hash>.woff2` (not inlined; only the 1.5 kB favicon SVG became `data:`) | Vite `closeBundle` 2× (`ssr`, then `client`), both **before** "Prerendering". Post-HTML hook: the adapter's `adapt(builder)` (wrap the adapter); it runs once with `builder.prerendered.paths` |

# Evidence

Versions: `@sveltejs/kit@3.1.1`, `svelte@5.57.3`, `@sveltejs/vite-plugin-svelte@7.3.1`, `@sveltejs/adapter-static@4.0.1`, `@sveltejs/adapter-node@6.0.1`, `vite@8.3.5`, `typescript@6.0.3`, `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. These are all npm latest; `sv` is 1.2.0. I reused the earlier `sv create` scaffold (minimal TS) and installed fresh. `allowBuilds: {esbuild: true}`.

Kit 3 config: `vite.config.ts` → `sveltekit({ compilerOptions, adapter })`. The Kit source `src/core/config/index.js` `extract_svelte_config()` reads `vite_config.plugins.find(p => p.name === 'vite-plugin-sveltekit-setup').api.options`, so to read the config, load the Vite config (or look for the `sveltekit(` call).

Fixture:

- `+layout.svelte` imports `@fontsource-variable/inter` and has `<svelte:head>` with the preconnect and Fraunces link.
- `+layout.ts`: `export const prerender = true`.
- `about/+page.svelte`; `posts/[id]/+page.ts` with `entries = () => [{id:'1'},{id:'2'}]`.
- `vite.config.ts` wraps the adapter (`adapt()` probe), adds the probe plugin, and `SK_ADAPTER=node` switches to adapter-node.

Static build (`evidence/build-static.log`):

```
vite v8.3.5 building ssr environment for production...   ✓ built
[probe] closeBundle ssr
Analysing routes
Building app
vite v8.3.5 building client environment for production... ✓ built
[probe] closeBundle client
Prerendering
> Using @sveltejs/adapter-static
[probe] adapter.adapt start ["/","/about","/posts/1","/posts/2"]
Wrote site to "build"
[probe] adapter.adapt done
```

`build/`: `index.html about.html posts/1.html posts/2.html robots.txt _app/version.json _app/immutable/assets/0.DT9BdvyF.css _app/immutable/assets/inter-{latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-wght-normal.<hash>.woff2`.

Head of `build/about.html`:

```
<link rel="icon" href="data:image/svg+xml,%3csvg...">            <- favicon inlined (assetsInlineLimit)
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap"/>
<link href="./_app/immutable/assets/0.DT9BdvyF.css" rel="stylesheet">   <- relative paths (paths.relative default)
```

`vite preview --port 4180 --strictPort` → `/posts/2` returned 200 with `<h1>Post 2</h1>`. The default 4173 was taken at first, and Vite silently moved to 4174.

adapter-node (`evidence/build-node.log`): the same probe order, then `> Using @sveltejs/adapter-node`. Output is `build/{index.js, handler.js, client/, prerendered/{index,about}.html, prerendered/posts/{1,2}.html, server/}`. `PORT=3012 node build` → `Listening on http://0.0.0.0:3012`. `/`, `/about`, `/posts/2` returned 200; `/posts/3` returned 404, because the whole app is prerendered and unknown ids aren't served.

# Surprises / gotchas

- SvelteKit 3 has no `svelte.config.js`. Detection and config reads must go through `vite.config.*`, where the adapter, prerender and paths options live inside `sveltekit({...})`.
- Prerendering runs after the last `closeBundle` (client), so closeBundle can't see HTML. Wrapping the adapter's `adapt()` is the only reliable post-HTML hook, and it also gives the exact path list. For a Vite-only hook, a plugin would have to run after Kit's own `closeBundle`/`buildApp` in the client environment.
- adapter-node puts prerendered HTML in `build/prerendered/` and assets in `build/client/`. The server build also has its own copy of the woff2 files in `build/server/_app/immutable/assets/`, which are never served.
- Built HTML references CSS through relative `./_app/...` paths.
- `vite preview` silently picks the next free port, so parse the URL from the log or pass `--strictPort`.
