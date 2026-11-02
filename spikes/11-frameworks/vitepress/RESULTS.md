| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| VitePress 1.6.4 (Vite 5.4.21) | `vitepress` dep + `<srcDir>/.vitepress/config.{ts,mts,js,mjs}` (srcDir is usually `docs/`, taken from the `vitepress build docs` script arg) | Always SSG → `docs/.vitepress/dist/` with flat `posts/1.html` (`cleanUrls: false` default) + `404.html`, `hashmap.json`; `outDir` is configurable | No server mode. `vitepress preview docs` (static, :4173) serves both `/posts/2` and `/posts/2.html` | `docs/**/*.md`; dynamic routes via `[id].md` + `[id].paths.ts`; `rewrites` in config. Machine list: `dist/hashmap.json` (keys `posts_1.md` → hash, i.e. path with `/`→`_`), or `siteConfig.pages` in `buildEnd` (`["posts/1.md",...]`) | `head: [['link', {...}]]` in `.vitepress/config.ts` (Google `<link>` kept, `&`→`&amp;`); fontsource is imported in `.vitepress/theme/index.ts` → CSS bundled into `dist/assets/style.<hash>.css`, woff2 in `dist/assets/inter-*-wght-normal.<hash>.woff2`. **The default theme also self-hosts its own `Inter`** (14 faces, `inter-roman-*`/`inter-italic-*`) and adds a `<link rel=preload as=font>` for `inter-roman-latin` | Vite `closeBundle` fires 2× (client, then server), `this.environment` undefined (Vite 5), both **before** "rendering pages". Use the VitePress config hook `buildEnd(siteConfig)`, once, after all HTML (or `transformHtml`/`postRender` per page) |

# Evidence

Versions: `vitepress@1.6.4` (npm `latest`; `next` is `2.0.0-alpha.21`), `vue@3.5.44`, `vite@5.4.21` (VitePress's dependency), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1. `allowBuilds: {esbuild: true}`.

Scaffold: `vitepress init` is an interactive clack prompt with no flags. I called the same code non-interactively: `node -e "import {scaffold,ScaffoldThemeType} from 'vitepress'; scaffold({root:'./docs', title:'Fixture', description:'fontphobia fixture', theme: ScaffoldThemeType.DefaultCustom, useTs:true, injectNpmScripts:false})"`. That produced `docs/{index,api-examples,markdown-examples}.md`, `docs/.vitepress/config.ts`, and `docs/.vitepress/theme/{index.ts,style.css}`. The npm scripts `docs:dev/build/preview` were written by hand to match what init injects.

Fixture changes: `config.ts` has the `head` (preconnect plus Fraunces stylesheet), `vite.plugins: [probe]`, and a `buildEnd` probe. `theme/index.ts` does `import '@fontsource-variable/inter'`, and `style.css` sets `--vp-font-family-base: 'Inter Variable'`. Dynamic route: `docs/posts/[id].md` + `docs/posts/[id].paths.ts` → 1, 2.

Build (`evidence/build.log`):
```
- building client + server bundles...
[probe] closeBundle -
[probe] closeBundle -
✓ building client + server bundles...
- rendering pages...
✓ rendering pages...
[probe] buildEnd .../docs/.vitepress/dist ["api-examples.md","index.md","markdown-examples.md","posts/1.md","posts/2.md"]
build complete in 1.20s.
```
HTML: `dist/{index,api-examples,markdown-examples,404}.html` and `dist/posts/{1,2}.html`.

Head of `posts/1.html`:
```
<link rel="preload stylesheet" href="/assets/style.bOPeAlj5.css" as="style">
<link rel="preload stylesheet" href="/vp-icons.css" as="style">
<link rel="preload" href="/assets/inter-roman-latin.Di8DUHzh.woff2" as="font" type="font/woff2" crossorigin="">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&amp;display=swap">
```
`style.<hash>.css` contains 14 `@font-face{font-family:Inter` (the theme's own, roman and italic × 7 subsets, `font-weight:100 900`), 7 `@font-face{font-family:Inter Variable` (fontsource), and 4 `Punctuation SC` (`src: local("PingFang SC Regular"), ...` only, `unicode-range` for CJK punctuation). There are no `data:` font URIs; all woff2 are emitted as `assets/<name>.<8-char hash>.woff2`.

Preview: `pnpm docs:preview` → `Built site served at http://localhost:4173/`. `/posts/2` → 200 and `/posts/2.html` → 200.

# Surprises / gotchas
- The default theme ships and preloads its own Inter (family name `Inter`, files `inter-roman-*.woff2`), so fontphobia sees two Inter families. Projects can opt out with `import DefaultTheme from 'vitepress/theme-without-fonts'` (export in `vitepress/package.json`). fontphobia should subset or handle the theme's Inter and also rewrite its `<link rel=preload as=font>`.
- The latest stable VitePress is still on Vite 5, so there's no Environment API and `this.environment` is undefined. `closeBundle` fires twice (client and SSR bundles) before any HTML is rendered.
- `buildEnd` is the clean post-HTML hook and gives `outDir` + `pages`. Note that `siteConfig.pages` lists source `.md` paths (after rewrites/dynamic expansion), not URLs.
- The output dir is inside the source tree (`docs/.vitepress/dist`), not at the project root.
- `vitepress init` can't run non-interactively, but `scaffold()` is exported and produces the same files.
