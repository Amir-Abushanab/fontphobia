# Walkthrough and font playground

This is a static site, published by `.github/workflows/pages.yml`. No browser dependencies are shipped to visitors. Pages validates the bakery's generated files before uploading this directory.

The browsable `bakery/before/` and `bakery/after/` copies come from `examples/bakery`. Run `pnpm bakery:build` after changing that source; it reruns the audit, verification and resource measurements, then refreshes the copies, reports, screenshots, and walkthrough. `node scripts/check-bakery.mjs` refuses stale source/output pairs. See `examples/bakery/README.md` for the measurement scope and photo credits.

`scripts/bakery-walkthrough.mjs` renders two regions of the page. The three-files figure is between the `bakery:files:start` and `bakery:files:end` comments, above the playground. The example site is between `bakery:start` and `bakery:end`, below it. Their numbers come from the measured files. Keep the overview brief; methodology, build output and the optional failing diff live in native disclosures. The playground and setup sections are edited directly in `index.html`.

The walkthrough's own crawl excludes `/bakery/**`, which the bakery builder audits separately. Its manifest records the original bakery font declarations as unchanged faces, so `check` tracks them without optimizing the baseline.

Its rendering check masks images, as the bakery check does, to compare font rendering without JPEG rasterization noise.
`check.allowChars` covers `≤`, which appears only in the system-monospace verification transcript inside a collapsed disclosure.

The hero's "Copy for your agent" button copies a task line followed by the package's agent skill, `packages/cli/skills/fontphobia/SKILL.md`. The Pages workflow copies that file to `skills/fontphobia/SKILL.md` beside the page, so the button and the published skill are the same text. It fetches that file only when someone points at, focuses or clicks the button, so a page load makes no request for it; served from the repository, where the file isn't, or when the fetch fails, the button copies the task line with a link to the README. Its labels are ASCII, which the core files always hold.

`demo.js` uses the character ranges and sizes embedded in `index.html` to show which of this page's font files a sentence needs. The same generated metadata is available in `demo-data.json`. A deferred classic script and embedded data let the playground work over HTTP and directly from a local file. This is a calculation for the entered text, not a network measurement of the whole page. When the text needs the extended or rest file, a note says that these fonts were split for this page's text: a site that used those characters would have had them planned into core. Original fonts are loaded with `FontFace` only when the comparison is opened.

After changing the page, check its existing font coverage before rebuilding:

```sh
node packages/cli/src/cli.ts audit --cwd site --dist .
node packages/cli/src/cli.ts check --cwd site
node packages/cli/src/cli.ts verify --cwd site
```

If the fonts need rebuilding, regenerate the demo metadata afterwards:

```sh
node scripts/site-demo-data.mjs
```

The Greek preset deliberately exercises Inter's rest file; Fraunces lacks those characters and uses a fallback. `check` may note these strings in `demo.js`. They are examples of content outside the subsets, rather than text to promote into the page's core file.

Run the data consistency and Chrome interaction tests with:

```sh
pnpm vitest run packages/crawler/test/demo.test.ts
```
