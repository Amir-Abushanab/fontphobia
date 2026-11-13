| Framework                         | Detected by                                                                                                    | Static output                                                                                                                            | Server mode                                                                                                                    | Routes                                                                                                                                                                                                                                                                                                              | Head / fonts                                                                                                                                                                                                                                                                                                                      | Plugin                                                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starlight 0.42.8 (on Astro 7.4.5) | `@astrojs/starlight` dep + `starlight(` integration in `astro.config.{mjs,ts}` (check this before plain Astro) | Static by default → `dist/` with directory-style `guides/example/index.html`, `posts/1/index.html`, plus `404.html` and `dist/pagefind/` | Same as Astro: `astro preview` (:4321; auto-backgrounds for agents, so use `--ignore-lock --port N`); SSR only with an adapter | `src/content/docs/**/*.{md,mdx}` (the `docs` collection; Starlight injects the catch-all route) + `src/pages/**` for custom pages; sidebar in the `starlight({sidebar})` config. Machine list: `astro:build:done` `pages[].pathname`; `@astrojs/sitemap` (bundled) writes `sitemap-index.xml` only if `site` is set | `starlight({ head: [{tag:'link',attrs:{...}}] })` → Google `<link>` kept (`&` → `&amp;`); fonts via `customCss: ['@fontsource-variable/inter', './src/styles/fonts.css']` + `--sl-font`; fontsource CSS is bundled into `dist/_astro/middleware.<hash>.css` (not inlined), woff2 → `dist/_astro/inter-*-wght-normal.<hash>.woff2` | Vite `closeBundle` fires 6×: `ssr, astro, client, prerender, client`, then **`astroImageService` after HTML generation**. Reliable hook: `astro:build:done` (runs after Starlight's own Pagefind indexing if the integration is listed after `starlight()`) |

# Evidence

Scaffold: `pnpm create astro@5.3.1 starlight --template starlight --no-install --no-git --yes --skip-houston`. The template pins `astro: ^7.2.10`, and pnpm 12's default minimum release age resolved that to **7.4.4**, because 7.4.5 was published 2026-11-02T14:26Z, about 6 h before this run. I added `minimumReleaseAgeExclude: [astro]` to `pnpm-workspace.yaml` and ran `pnpm add astro@^7.4.5`. Final versions: `@astrojs/starlight@0.42.8`, `astro@7.4.5`, `sharp@0.35.5`, `@fontsource-variable/inter@5.3.0`. `allowBuilds: {esbuild: true, sharp: false}`; sharp's prebuilt `@img/*` binaries work without its build script.

Fixture: `astro.config.mjs` has `customCss` (fontsource plus `src/styles/fonts.css`, which sets `--sl-font: 'Inter Variable'`), `head` with the Fraunces preconnect and stylesheet, the probe Vite plugin, and the probe integration. `src/pages/posts/[id].astro` uses `<StarlightPage>` with `getStaticPaths` → 1, 2. The starter's docs pages are kept.

Build (`evidence/build.log`):

```
[probe] closeBundle ssr / astro / client        (content sync + types)
[build] output: "static"
[probe] closeBundle prerender
[probe] closeBundle client
 generating static routes  /404.html /posts/1/index.html /posts/2/index.html /guides/example/index.html /index.html /reference/example/index.html
[probe] closeBundle astroImageService          <- after HTML exists
[starlight:pagefind] Building search index with Pagefind... Found 6 HTML files.
[WARN] [@astrojs/sitemap] The Sitemap integration requires the `site` astro.config option. Skipping.
[probe] astro:build:done .../starlight/dist/ ["404/","posts/1/","posts/2/","guides/example/","","reference/example/"]
```

Output CSS: `dist/_astro/middleware.QxN_-0Sr.css` (65.8 kB, holds the Inter `@font-face` rules with `url(/_astro/inter-...woff2)`), `ec.w36nc.css` (Expressive Code), `print.ehPL0gv-.css`. The only `data:` URIs are SVG icons; no fonts are inlined.

Head in built `posts/1/index.html`:

```
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap"/>
<link rel="stylesheet" href="/_astro/print.ehPL0gv-.css" media="print">
<link rel="stylesheet" href="/_astro/middleware.QxN_-0Sr.css">
```

Preview: `astro preview --ignore-lock --port 4330` → `astro v7.4.5 ready in 18 ms ┃ Local http://localhost:4330/` (JSON-wrapped log line, because an agent was detected). `curl /posts/2/` → 200, `<h1 id="_top">Post 2</h1>`.

# Surprises / gotchas

- The Starlight starter has `^7.2.10` for astro, so a fresh install under pnpm 12 gets an older astro than `create astro` itself used (7.4.4 vs 7.4.5) unless astro goes in `minimumReleaseAgeExclude`.
- The fontsource CSS goes into a chunk named `middleware.<hash>.css`. It is not inlined (unlike minimal Astro), because Starlight's combined CSS is larger than 4 kB.
- An extra `closeBundle` (`astroImageService`) fires after the HTML is written, because image optimization runs as its own Vite build. So "last closeBundle" depends on whether the site has images. Don't use closeBundle; use `astro:build:done`.
- Pagefind indexes the HTML inside Starlight's `astro:build:done`. A fontphobia integration listed after `starlight()` runs after that, which is fine because subsetting doesn't change text.
- Starlight's `head` config entity-encodes `&` in the `href`; plain Astro layouts keep the raw `&`. Compare URLs after HTML-decoding.
