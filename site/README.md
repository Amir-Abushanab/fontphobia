# Walkthrough and font playground

This is a static site, published by `.github/workflows/pages.yml`. No build step or browser dependencies are shipped with it.

`demo.js` uses the character ranges and sizes in `demo-data.json` to show which of this page's font files a sentence needs. This is a calculation for the entered text, not a network measurement of the whole page. Original fonts are loaded with `FontFace` only when the comparison is opened.

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
