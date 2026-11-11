# Little Levain

A fictional four-page bakery with local responsive photos, system emoji, a searchable menu, category/vegan filters, opening hours and a journal. It takes no orders and makes no external requests during page loads.

Browse the published [original](https://amir-abushanab.github.io/fontphobia/bakery/before/) and [optimized](https://amir-abushanab.github.io/fontphobia/bakery/after/) copies. The bar at the top switches versions on the current page and keeps the menu filters. The [walkthrough](https://amir-abushanab.github.io/fontphobia/#walkthrough) links all measurements and reports.

The input fonts are the full Inter variable WOFF2 and Google's Latin Fraunces WOFF2, under the SIL Open Font License (`fonts/*-LICENSE.txt`). Photos are credited in [images/CREDITS.md](images/CREDITS.md) and on the visit page. These measurements apply to these input fonts; sites already using language subsets may save less.

To try fontphobia on a copy:

```sh
cp -R examples/bakery /tmp/little-levain && cd /tmp/little-levain
pnpm dlx fontphobia
```

To rebuild the published comparison, from the repository root:

```sh
pnpm bakery:build
node scripts/check-bakery.mjs
```

The generator audits four pages at four viewport widths and a browser font-size sweep, subsets with the defaults, and verifies fonts and text rendering at 1×/2× density. It builds both copies from this folder, sharing the same image/script files, then measures every page at 390/1280 px and 1×/2× density in fresh Chrome contexts. All images are loaded, including lazy images. Totals count response bodies, excluding HTTP headers/TLS and text compression; no load-time or Core Web Vitals claim is made.

Photographs are masked for text-pixel checks because Chrome can resample the same JPEG differently between loads. Their response hashes and exact positions/sizes must also match. Published-copy comparisons allow one RGB level per channel, also observed between repeated captures with unchanged fonts. Strict pixel counts and raw unmasked differences are retained in `site/bakery/measurements.json`. Bandwidth measurements include the visible photos. The filtered menu is compared too.

The generator refreshes `site/bakery/`, the walkthrough's figures, and a measured diff from a separate `limit-axes` build. That optional build is never deployed as the optimized version. GitHub Pages checks source and output fingerprints before publishing, so changing the web assets in this folder requires rebuilding the demonstration.
