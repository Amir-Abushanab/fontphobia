| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Eleventy 3.1.7 | `@11ty/eleventy` dep + `eleventy.config.{js,mjs,cjs}` (or legacy `.eleventy.js`) | Always SSG → `_site/` (configurable `dir.output`) with directory-style `about/index.html`, `posts/1/index.html` (pagination + `permalink`) | No production server. `eleventy --serve` is a dev server (:8080, `--port`); `/about` → 301 `/about/`. Serve `_site/` with any static server | Templates under `dir.input` (`src/`); permalinks are computed, so source paths aren't routes. Machine list: the `eleventy.after` event's `results[]` (`{url, outputPath, inputPath, content}`) | Layout `src/_includes/base.njk` `<head>`; Google `<link>` kept byte-for-byte (raw `&`). **No bundler:** fontsource needs `addPassthroughCopy` of `index.css` + `files/*.woff2` (paths are **unhashed**, `/fonts/inter/files/inter-latin-wght-normal.woff2`) | No Vite/webpack, so closeBundle/done don't apply. Hooks: `eleventyConfig.on('eleventy.before' / 'eleventy.after')`; `eleventy.after` runs once after all templates are written. Also `addTransform` per output file |

# Evidence

Versions: `@11ty/eleventy@3.1.7` (npm latest; beta 3.1.2-beta.4, canary 4.0.0-alpha.10), `@fontsource-variable/inter@5.3.0`, pnpm 12.9.1, node 24.21.0. Eleventy has no official `create` starter; the docs' Get Started is `npm init` + `npm install @11ty/eleventy`, which I did with pnpm. No build scripts.

Fixture:
- `eleventy.config.js` (ESM, `export const config = { dir: { input: "src", output: "_site" } }`): passthrough copy of fontsource `index.css` → `/fonts/inter/index.css` and `files/*-wght-normal.woff2` → `/fonts/inter/files/`; `eleventy.before`/`eleventy.after` probes.
- `src/_includes/base.njk`: preconnect + Fraunces `<link>` + `<link rel=stylesheet href=/fonts/inter/index.css>`.
- `src/index.md`, `src/about.md`; `src/posts/post.njk` with `pagination` over `ids: ["1","2"]` and `permalink: "/posts/{{ id }}/"`.

Build (`evidence/build.log`):
```
[probe] eleventy.before ./_site/
[11ty] Writing ./_site/posts/1/index.html from ./src/posts/post.njk
[11ty] Writing ./_site/about/index.html from ./src/about.md (liquid)
[11ty] Writing ./_site/index.html from ./src/index.md (liquid)
[11ty] Writing ./_site/posts/2/index.html from ./src/posts/post.njk
[probe] eleventy.after ./_site/ [["/posts/1/","./_site/posts/1/index.html"],["/posts/2/","./_site/posts/2/index.html"],["/about/","./_site/about/index.html"],["/","./_site/index.html"]]
[11ty] Copied 8 Wrote 4 files in 0.08 seconds (v3.1.7)
```
`_site/`: `index.html, about/index.html, posts/{1,2}/index.html, fonts/inter/index.css, fonts/inter/files/inter-{latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-wght-normal.woff2`.

Head of `about/index.html`:
```
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap">
<link rel="stylesheet" href="/fonts/inter/index.css">
```
Dev server: `eleventy --serve --port=8089` → `[11ty] Server at http://localhost:8089/`. `/`, `/about/`, `/posts/2/` and the woff2 returned 200; `/about` returned 301.

# Surprises / gotchas
- With no asset pipeline, fontsource files keep their original names (no hash). fontphobia can rewrite them in place, but cache-busting is the user's problem.
- `eleventy.after` `results` is the cleanest route list (URL → output path) for any SSG here.
- In `--serve` mode, Eleventy 3 emulates passthrough copy (it serves from `node_modules` without writing to `_site`). Crawl a real `eleventy` build, not the dev server.
- Markdown files are processed with Liquid by default, so the raw HTML `<h1>` passes through.
