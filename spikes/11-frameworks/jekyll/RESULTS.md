| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |
|---|---|---|---|---|---|---|
| Jekyll 4.4.1 (minima 2.5.2 theme, Ruby 3.4.1, Bundler 2.6.3) | `Gemfile` with `gem "jekyll"` + `_config.yml` | Always SSG → `_site/` (`destination`); pages are directory-style `about/index.html`; posts get the default permalink `/:categories/:year/:month/:day/:title.html` → `jekyll/update/2026/11/01/second-post.html` | No production server. `bundle exec jekyll serve` (WEBrick, **127.0.0.1:4000**, `--port`, `--skip-initial-build --no-watch` to serve an existing `_site`); `/about` → 301; extensionless `/…/second-post` also 200 | `*.md`/`*.html` pages + `_posts/YYYY-MM-DD-*.md` (+ collections, permalinks). Machine list: the `:site, :post_write` hook (`site.pages + site.posts.docs` → `url`); `feed.xml` (jekyll-feed, posts only) | Theme include `_includes/head.html` (copied from the minima gem to override; minima 2.5 has no `custom-head`); Google `<link>` kept byte-for-byte. **No npm pipeline:** fontsource is copied into `assets/fonts/inter/` by a pnpm script; files are unhashed | No bundler. Ruby plugin in `_plugins/*.rb`: `Jekyll::Hooks.register :site, :post_write` runs once after every file is written (`:post_render` runs before). Not available on GitHub Pages' safe mode |

# Evidence

Toolchain: `ruby 3.4.1`, `Bundler 2.6.3` (rbenv shims; no global gems installed). `bundle config set --local path vendor/bundle` (`.bundle/config`), Gemfile `gem "jekyll", "~> 4.4.1"`, then `bundle install` (36 gems into `./vendor/bundle`).
- Scaffold: `bundle exec jekyll new . --force --skip-bundle` gave the official minima starter (`_config.yml`, `index.markdown`, `about.markdown`, `404.html`, `_posts/2026-11-02-welcome-to-jekyll.markdown`, Gemfile with `minima ~> 2.5`, `jekyll-feed ~> 0.12`).
- A second `bundle install` brought it to 39 gems.
- Versions: `jekyll 4.4.1` (latest on rubygems), `minima 2.5.2`, `jekyll-feed 0.18.0`, `sass-embedded 1.107.1`, `@fontsource-variable/inter@5.3.0` (pnpm 12.9.1, only for the font files).

Fixture:
- `_includes/head.html`: copied from `vendor/bundle/ruby/3.4.0/gems/minima-2.5.2/_includes/head.html`, plus the preconnect, the Fraunces `<link>`, `<link rel=stylesheet href="/assets/fonts/inter/index.css">` and a body font-family.
- `package.json` `fonts` script copies `index.css` + `files/*-wght-normal.woff2` into `assets/fonts/inter/`; `build` = `pnpm fonts && bundle exec jekyll build`.
- `_posts/2026-11-01-second-post.markdown` is the second instance of the post route pattern.
- `about.markdown` gets a Fraunces `<h1>`.
- `_plugins/probe.rb` registers the hooks.
- `_config.yml` adds the pnpm files and `evidence/RESULTS.md` to `exclude` (Jekyll 4 merges this with its defaults, so `vendor/bundle`, `node_modules` and `Gemfile*` stay excluded).

Build (`JEKYLL_ENV=production pnpm build`, `evidence/build.log`): dart-sass deprecation warnings from minima's `lighten()`, then:
```
[probe] site post_render (6 pages, 2 posts; nothing written yet)
[probe] site post_write .../jekyll/_site ["/", "/404.html", "/about/", "/assets/main.css", "/assets/main.css.map", "/feed.xml", "/jekyll/update/2026/11/01/second-post.html", "/jekyll/update/2026/11/02/welcome-to-jekyll.html"]
                    done in 0.926 seconds.
```
`_site/`: `index.html, 404.html, about/index.html, jekyll/update/2026/11/0{1,2}/*.html, feed.xml, assets/main.css(+.map), assets/minima-social-icons.svg, assets/fonts/inter/index.css, assets/fonts/inter/files/inter-*-wght-normal.woff2 (7)`.

Head of `about/index.html`:
```
<link rel="stylesheet" href="/assets/main.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap">
<link rel="stylesheet" href="/assets/fonts/inter/index.css">
```
Serve: `bundle exec jekyll serve --port 4005 --skip-initial-build --no-watch` → `Server address: http://127.0.0.1:4005/`. `/` 200, `/about/` 200, `/about` 301, `/jekyll/update/2026/11/01/second-post.html` 200, the same path without `.html` 200, `/nope` 404.

# Surprises / gotchas
- The fontsource variable package's `files/` has 42 woff2 (wght, opsz, standard × normal/italic), but `index.css` references only the 7 `*-wght-normal` ones. Copying the whole folder ships 35 unused files.
- Theme heads live inside the gem (`vendor/bundle/.../minima-2.5.2/_includes/head.html`). Overriding means copying the file into `_includes/`; fontphobia would need to look in both places, or just work on `_site`.
- `jekyll serve` binds only to `127.0.0.1` (not `localhost`/`::1`) by default.
- `:site, :post_write` is a clean post-HTML hook, but `_plugins/` is ignored in `--safe` mode (GitHub Pages' classic builder).
- `jekyll new` dates the sample post with today's date, so post URLs change with the scaffold date.
