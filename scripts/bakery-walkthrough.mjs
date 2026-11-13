import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_BASE, codePointsOf, parseUnicodeRange } from '../packages/core/src/index.ts';

const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
const percent = (before, after) => Math.round((1 - after / before) * 100);
const escape = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function refreshWalkthrough(repo, results, report) {
  const path = join(repo, 'site/index.html');
  let html = readFileSync(path, 'utf8');
  const mobile = results.pages.filter((page) => page.viewport === 390 && page.dpr === 2);
  const before = mobile[0].before.fontBytes;
  const savings = mobile.map((page) => percent(before, page.after.fontBytes));
  // One number when every page saves the same share.
  const saved = [...new Set([Math.min(...savings), Math.max(...savings)])].join('–');
  html = html.replace(
    /(<h1 id="content"[^>]*>[\s\S]*?<\/h1>\s*)<p>[\s\S]*?<\/p>/,
    '$1<p>Split fonts around the text on your site. Check the result in Chrome.</p>',
  );
  html = html.replace(
    /<meta property="og:description"[^>]*>/,
    '<meta property="og:description" content="Browse the example site before and after, see the measured savings, and try the live font playground.">',
  );

  const titles = { '/': 'Home', '/menu.html': 'Menu', '/about.html': 'Visit us', '/journal/levain.html': 'Journal' };
  const rows = mobile
    .map((p) => {
      const file = p.page === '/' ? '' : p.page.slice(1);
      return `<tr><th scope="row"><a href="bakery/after/${file}">${titles[p.page]}</a></th><td class="n"><span class="was">${kb(p.before.fontBytes)} →</span><strong>${kb(p.after.fontBytes)}</strong><small>${percent(p.before.fontBytes, p.after.fontBytes)}% less</small></td><td class="n"><span class="was">${kb(p.before.totalBytes)} →</span><strong>${kb(p.after.totalBytes)}</strong><small>${percent(p.before.totalBytes, p.after.totalBytes)}% less</small></td></tr>`;
    })
    .join('\n');

  // Both families use one byte scale; total split size can exceed the original.
  const scale = Math.max(
    ...results.faces.map((face) =>
      Math.max(
        face.source.bytes,
        face.outputs.reduce((sum, output) => sum + output.bytes, 0),
      ),
    ),
  );
  const bars = [...results.faces]
    .toSorted((a, b) => b.family.localeCompare(a.family))
    .map((face) => {
      const original = (face.source.bytes / scale) * 100;
      const total = face.outputs.reduce((sum, output) => sum + output.bytes, 0);
      const parts = face.outputs
        .map((output) => `<div class="${output.role}" style="width:${(output.bytes / total) * 100}%"></div>`)
        .join('');
      return `<div class="font-bars"><div class="bar-row"><div class="lbl">${escape(face.family)}<small>Original · ${kb(face.source.bytes)}</small></div><div class="track" role="img" aria-label="Original ${escape(face.family)}: ${kb(face.source.bytes)}"><div class="orig" style="width:${original}%"></div></div></div>
<div class="bar-row"><div class="lbl">Subsetted<small>Loaded as needed</small></div><div class="track" role="img" aria-label="Subsetted ${escape(face.family)}: ${face.outputs.map((output) => `${output.role === 'ext' ? 'extended' : output.role} ${kb(output.bytes)}`).join(', ')}"><div class="split-files" style="width:${(total / scale) * 100}%">${parts}</div></div></div></div>`;
    })
    .join('\n');
  const fileRows = results.faces
    .flatMap((face) =>
      face.outputs.map(
        (output) =>
          `<tr><th scope="row">${escape(face.family)} ${output.role === 'ext' ? 'extended' : output.role}</th><td class="n">${kb(output.bytes)}</td></tr>`,
      ),
    )
    .join('\n');
  // What the pages use beyond core's fixed part, said only when no measured page needed another file.
  const coreOf = (face) => face.outputs.find((o) => o.role === 'core');
  const cores = results.faces.reduce((sum, face) => sum + coreOf(face).bytes, 0);
  const fixed = new Set(CORE_BASE);
  const extras = [
    ...new Set(results.faces.flatMap((face) => [...codePointsOf(parseUnicodeRange(coreOf(face).unicodeRange))])),
  ]
    .filter((cp) => !fixed.has(cp))
    .toSorted((a, b) => a - b)
    .map((cp) => String.fromCodePoint(cp))
    .filter((ch) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(ch));
  const inCore =
    extras.length && results.pages.every((page) => page.after.fontBytes === cores)
      ? `<p class="small-print">Beyond ASCII and common punctuation, the pages use <code>${escape(extras.join(' '))}</code>. All of them are in core, so every page downloads the core files alone.</p>\n`
      : '';
  const image = results.limitAxes.image;
  const crop = { ...image.crop, x: image.crop.x + 8, width: image.crop.width - 16 };
  const cropStyle = `--diff-ratio:${crop.width} / ${crop.height};--diff-image-width:${(image.width / crop.width) * 100}%;--diff-image-left:${(-crop.x / crop.width) * 100}%;--diff-image-top:${(-crop.y / crop.width) * 100}%`;

  const files = `<h2 id="problem">One font, three files</h2>
<p>Core holds the characters your pages use. Extended holds the Latin letters none of them use yet. Rest holds everything else in the font. The browser loads core first, then another file only when text needs it.</p>
<p>A character that few pages use could go in core or in extended. fontphobia measures both and keeps the one where your pages download less in total.</p>
<figure class="panel" id="plan">
  <div class="bars">${bars}</div>
  <div class="legend"><span><i class="sw core"></i>Core</span><span><i class="sw ext"></i>Extended</span><span><i class="sw rest"></i>Rest</span></div>
  <figcaption>The example site's fonts, to scale. Together the three files are larger than the original. A page downloads only the ones it needs.</figcaption>
</figure>`;

  const section = `<h2 id="walkthrough">Browse the example site</h2>
<div class="bakery-links"><a href="bakery/before/">Original fonts →</a><a href="bakery/after/">Optimized fonts →</a></div>
<figure class="bakery-hero"><a class="bakery-preview" href="bakery/after/" aria-label="Browse the optimized Little Levain home page"><img src="img/bakery-home.jpg" width="1280" height="900" loading="lazy" alt="Little Levain's home page, with large serif type and a photograph of sourdough loaves."></a><figcaption>Little Levain · a fictional bakery, with measured downloads</figcaption></figure>
<div class="result-heading"><p><strong>${saved}%</strong> less font data</p><span>Same photos, content and interactions.</span></div>
<div class="scroll"><table class="t results"><caption>Cold-cache downloads · before → after</caption><thead><tr><th scope="col">Page</th><th scope="col">Fonts</th><th scope="col">Whole page</th></tr></thead><tbody>${rows}</tbody></table></div>
${inCore}<p class="small-print" id="verify">Same layout across all ${results.verification.publicComparisons.length} browser checks.</p>
<details class="disclosure" id="audit"><summary>How it's measured and checked</summary>
<p>Cold-cache visits at 390 px and 2× density, with every photo loaded. Sizes count response bodies: HTML, CSS, JavaScript, photos and fonts. They exclude headers and gzip savings on text.</p>
<p>Only the fonts change. The baseline self-hosts full Inter and Google's Latin Fraunces. Sites already using language subsets may save less.</p>
<p>Font verification passed ${results.verification.comparisons.length} comparisons. Separate checks of the published copies cover all four pages at 390 and 1280 px, at 1× and 2× density, plus a filtered menu.</p>
<p>Text pixels matched within one RGB level per channel. Photos have identical bytes, positions and sizes; they are masked for pixel checks because Chrome can resample the same JPEG differently. The text tolerance covers colour noise also seen with unchanged fonts. Strict and unmasked counts are in the raw results.</p>
<figure><a class="bakery-preview" href="bakery/after/menu.html"><img src="img/bakery-menu.jpg" width="1280" height="900" loading="lazy" alt="The bakery menu with search, category filters and a vegan-only checkbox."></a><figcaption>Try “creme”, Pastry or Vegan only in either version.</figcaption></figure>
<p><a href="bakery/measurements.json">Full measurements</a> · <a href="https://github.com/Amir-Abushanab/fontphobia/tree/main/examples/bakery">Source and photo credits</a></p>
</details>
<details class="disclosure"><summary>Exact file sizes and build output</summary>
<div class="scroll"><table class="t"><caption>The bakery's generated fonts</caption><thead><tr><th scope="col">File</th><th scope="col">Size</th></tr></thead><tbody>${fileRows}</tbody></table></div>
<p>HarfBuzz checks words before splitting. Characters move into core if a split changes their shaping. Axes, hinting, font features and glyph names are kept.</p>
<div class="term"><pre>${escape(report)}</pre></div>
<p><code>pnpm bakery:build</code> reproduces these copies, measurements and screenshots. Pages checks their hashes before publishing.</p>
<p><a href="bakery/report.txt">Build report</a> · <a href="bakery/font-files.json">Font file data</a></p>
</details>
<details class="disclosure" id="verify-fail"><summary>See a change the rendering check caught</summary>
<p>The optional <code>limit-axes</code> build saves another ${kb(results.limitAxes.saving)}, but ${results.limitAxes.ok ? 'passes with rounding' : 'fails verification'}. The browsable demo uses the defaults.</p>
<figure class="diff-figure" style="${cropStyle}">
  <svg class="diff-filters" width="0" height="0" aria-hidden="true"><defs><filter id="diff-highlight" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="5" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="5" offset="0"/><feFuncB type="gamma" amplitude="1" exponent="5" offset="0"/></feComponentTransfer><feColorMatrix type="matrix" values="1 0 0 0 0  0 0.25 0.75 0 0  0 0 1 0 0  0 0 0 1 0"/></filter></defs></svg>
  <p class="diff-label">“Prices in euros.”</p>
  <div class="diff-detail"><img class="diff-highlight" src="img/verify-limit-axes.png" width="${image.width}" height="${image.height}" loading="lazy" alt="Magnified menu diff around Prices in euros, with changed pixels shown in orange."></div>
  <div class="legend"><span><i class="sw changed"></i>Changed pixels</span><span><i class="sw context"></i>Text for context</span></div>
  <details class="diff-full"><summary>Full diff</summary><a href="img/verify-limit-axes.png">Original PNG (${image.width} × ${image.height})</a><img class="diff-highlight" src="img/verify-limit-axes.png" width="${image.width}" height="${image.height}" loading="lazy" alt="Full limit-axes menu diff, with changed pixels in orange."></details>
  <figcaption>Measured at 360 px and 2× density. Detail enlarged, contrast increased, photos masked.</figcaption>
</figure>
<details class="transcript"><summary>Verification output</summary><div class="term"><pre>${escape(results.limitAxes.report)}</pre></div></details>
</details>`;
  // Two regions of the page: the three-files figure above the playground, the example site below it.
  for (const [name, content] of [
    ['bakery:files', files],
    ['bakery', section],
  ]) {
    const marker = new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`);
    if (!marker.test(html)) throw new Error(`The ${name} markers are missing from site/index.html.`);
    html = html.replace(marker, () => `<!-- ${name}:start -->\n${content}\n<!-- ${name}:end -->`);
  }
  writeFileSync(path, html);
}
