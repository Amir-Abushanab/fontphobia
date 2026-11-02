# Spike 11 brief: verify framework profiles

Context: fontphobia (see /Users/amir/Code/fontphobia/PLAN.md §7.1.1 and §6.8) is a CLI that crawls a site's built output or production server with Chrome, then subsets fonts. For every framework it needs a "profile": how to detect it, where the build writes HTML, how to start the production server, where routes are declared, where head tags live, and which build hook a plugin can use. The §7.1.1 table was written from older knowledge; verify it on current versions.

## Per framework, in /Users/amir/Code/fontphobia/spikes/11-frameworks/<slug>/

1. Scaffold the official starter non-interactively at the CURRENT latest version (record exact versions). Use pnpm 12.9.1 (`packageManager` field). pnpm blocks build scripts: allow needed ones under `allowBuilds:` in a local `pnpm-workspace.yaml`. pnpm 12 also enforces a minimum release age; if a fresh version is blocked, add it to `minimumReleaseAgeExclude` there and note it. Each dir is standalone (its own pnpm-workspace.yaml so it doesn't join a parent workspace). No git init.
2. Add `@fontsource-variable/inter` (import it in the app's root/layout) and one Google Fonts `<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap">` in the framework's idiomatic head config.
3. Add at least two routes, one dynamic (e.g. `/posts/[id]` with two prerendered ids).
4. Add a tiny inline Vite (or webpack) plugin: `{ name: 'probe', closeBundle() { console.log('[probe] closeBundle', this.environment?.name ?? '-') } }` (adapt for webpack: `compiler.hooks.done`). Record how many times it fires per build and with which environment names, and which call happens last (when all HTML exists).
5. Build. Record:
   - static output dir and the HTML files produced (prerendered/SSG); what config enables prerender/static;
   - where the fontsource CSS and woff2 files end up (paths, hashing, whether any are inlined as data: URIs by assetsInlineLimit);
   - whether the Google `<link>` survives into built HTML as-is;
   - production server command and default port, and that it serves the built pages (curl one route);
   - where routes are declared and the most reliable machine-readable route list (generated manifest file, prerender list, build output) — give file path and format;
   - where head tags live.
6. Detection: which package name / config file reliably identifies the framework.

Write `<slug>/RESULTS.md`: first a single markdown table row in this exact column order:
`| Framework | Detected by | Static output | Server mode | Routes | Head / fonts | Plugin |`
then the evidence (commands, versions, file listings, probe output), then surprises/gotchas. Keep the fixture app (it becomes the smoke fixture) but delete node_modules and build outputs at the end; keep lockfiles.

Don't edit PLAN.md or other spike dirs. Don't commit. If something can't be done non-interactively or needs a tool that isn't installed (Ruby, Hugo binary), record what you could verify from official docs, cite URLs, and mark the row "docs only".

Final message: ≤15 lines: the table rows, plus one line per notable surprise.
