---
"fontphobia": patch
---

`verify` no longer fails on rendering noise, and no longer clears a small real change as noise.

Chrome's GPU rasterizer does not draw every load alike. Text between about 162 and 256 device pixels tall, such as a 94 px heading at 2×, comes out with a few edge pixels one level lighter or darker each time, whatever the font. On a machine that rasterizes on the GPU (a Mac, for one), `verify` compared how many pixels differed between the two sides with how many differed between two loads of one side. That cleared most of the noise as `flaky`, reported a regression in about one run in ten of a site with such a heading, and could clear a real change smaller than the noise.

- Chrome rasterizes pages and 2D canvases on the CPU during `verify`, which draws the same pixels on every load. On the example site all 32 comparisons are now identical on the first load, and `verify` takes half as long.
- A pixel difference at unchanged layout is loaded again and reported when it repeats: each pixel has to come out the same from the original fonts and from the new files on every load. The difference is confirmed once three loads in a row match the first exactly, and `verify` keeps loading, up to twelve times, while anything else on the page changes between loads.
- When only part of a difference repeats, the report and the diff image show that part.
