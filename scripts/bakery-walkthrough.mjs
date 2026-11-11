import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
const percent = (before, after) => Math.round((1 - after / before) * 100);
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function refreshWalkthrough(repo, results, report) {
  const path = join(repo, 'site/index.html');
  let html = readFileSync(path, 'utf8');
  const mobile = results.pages.filter((page) => page.viewport === 390 && page.dpr === 2);
  const before = mobile[0].before.fontBytes;
  const minimum = Math.min(...mobile.map((p) => p.after.fontBytes));
  const maximum = Math.max(...mobile.map((p) => p.after.fontBytes));
  const inter = results.faces.find((face) => face.family === 'Inter');
  const shaping = results.faces.filter((face) => face.repair?.count).map((face) => `${face.family}: ${face.repair.count} characters moved into core`).join('; ');
  html = html.replace(/(<h1 id="content"[^>]*>[\s\S]*?<\/h1>\s*)<p>[\s\S]*?<\/p>/, `$1<p>fontphobia splits fonts by the characters your pages use, then checks the result in Chrome. The bakery below downloads ${kb(minimum)}–${kb(maximum)} of fonts per page, down from ${kb(before)}.</p>`);
  html = html.replace(/<meta property="og:description"[^>]*>/, '<meta property="og:description" content="Browse the bakery with original and optimized fonts, try the font playground, and inspect the measured results.">');
  const problem = `<h2 id="problem">Why split a font?</h2>
<p>The bakery uses ${inter.used} of the ${inter.source.characters.toLocaleString('en-US')} characters in its ${kb(inter.source.bytes)} Inter variable font. A browser downloads that whole file even when a page uses only a few dozen characters.</p>
<p>fontphobia puts frequently used characters in a core file, less common ones in an extended file, and the remaining character set in a rest file. CSS tells the browser which files the page needs.</p>
<p>It checks word shaping before writing the split, then compares the pages in Chrome. Options that change rendering are off by default.</p>

`;
  html = html.replace(/<h2 id="problem">[\s\S]*?(?=<h2 id="how">)/, problem);
  const rows = mobile.map((p) => {
    const title = { '/': 'Home', '/menu.html': 'Menu', '/about.html': 'Visit us', '/journal/levain.html': 'Journal' }[p.page];
    const file = p.page === '/' ? '' : p.page.slice(1);
    return `<tr><th scope="row"><a href="bakery/after/${file}">${title}</a></th><td class="n">${kb(p.before.fontBytes)} → ${kb(p.after.fontBytes)}<br><small>${percent(p.before.fontBytes, p.after.fontBytes)}% less · ${p.before.fontRequests} → ${p.after.fontRequests} requests</small></td><td class="n">${kb(p.before.totalBytes)} → ${kb(p.after.totalBytes)}<br><small>${percent(p.before.totalBytes, p.after.totalBytes)}% less</small></td></tr>`;
  }).join('\n');
  const fileRows = results.faces.flatMap((face) => face.outputs.map((output) => `<tr><th scope="row">${escape(face.family)} ${output.role === 'ext' ? 'extended' : output.role}</th><td class="n">${kb(output.bytes)}</td></tr>`)).join('\n');
  const image = results.limitAxes.image;
  // Keep the neighbouring sentence outside the magnified phrase.
  const crop = { ...image.crop, x: image.crop.x + 8, width: image.crop.width - 16 };
  const cropStyle = `--diff-ratio:${crop.width} / ${crop.height};--diff-image-width:${image.width / crop.width * 100}%;--diff-image-left:${-crop.x / crop.width * 100}%;--diff-image-top:${-crop.y / crop.width * 100}%`;
  const section = `<h2 id="walkthrough">Walkthrough: Little Levain</h2>
<p class="lead">Four pages, responsive photos, a searchable menu, ingredient filters, emoji and a journal. Little Levain is a fictional bakery; the sites below are working copies you can browse.</p>
<div class="bakery-links"><a href="bakery/before/">Browse original fonts →</a><a href="bakery/after/">Browse optimized fonts →</a></div>
<figure><a class="bakery-preview" href="bakery/after/" aria-label="Browse the optimized Little Levain home page"><img src="img/bakery-home.jpg" width="1280" height="900" loading="lazy" alt="Little Levain's home page, with large serif type and a photograph of sourdough loaves."></a><figcaption>Open either version and use the bar at the top to switch fonts on the same page.</figcaption></figure>
<p>Both versions have identical photos, content and menu behaviour. Only the font declarations and downloaded font files change. The baseline self-hosts the full Inter variable WOFF2 (${kb(inter.source.bytes)}) and Google's Latin Fraunces WOFF2 (${kb(results.faces.find((f) => f.family === 'Fraunces').source.bytes)}).</p>

<h3 id="audit">1. Measure the whole site</h3>
<p>The audit visits all four pages at ${results.verification.comparisons.map((c) => c.viewport).filter((n, i, a) => a.indexOf(n) === i).join(', ')} px widths, plus a browser font-size sweep. It records characters, weights, font features and words from rendered text.</p>
<p>These are cold-cache measurements of the published copies at 390 px wide and 2× density, after all photos have loaded:</p>
<div class="scroll"><table class="t"><caption>Font savings and whole-page resource savings</caption><thead><tr><th scope="col">Page</th><th scope="col">Fonts, before → after</th><th scope="col">All resources, before → after</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small-print">Resource sizes count response bodies, including photos, HTML, CSS, JavaScript and fonts. They exclude HTTP headers, TLS and gzip savings on text files. Each visit uses a fresh browser context and loads lazy images too. Emoji use the same system font in both copies.</p>
<p>These results apply to these input fonts. A site already serving language subsets may save less. The <a href="bakery/measurements.json">full measurements</a> include every resource's size and hash, results at 390 and 1280 px at 1× and 2× density, and the source fingerprint.</p>

<h3 id="plan">2. Split the fonts</h3>
<p>Core keeps the common characters. Extended contains the remaining text used on this site. Rest preserves the rest of the original character set, so later content can still use it.</p>
<div class="scroll"><table class="t"><caption>Generated font files</caption><thead><tr><th scope="col">File</th><th scope="col">Size</th></tr></thead><tbody>${fileRows}</tbody></table></div>
<p>${shaping ? `${escape(shaping)}. ` : ''}HarfBuzz checks the recorded words against the original font and moves characters when a file boundary changes kerning or shaping. Variable axes, hinting, font features and glyph names are kept.</p>

<h3 id="build">3. Write the files and CSS</h3>
<div class="term"><div class="bar"><span>your copy of examples/bakery</span></div><pre><span class="c">pnpm dlx fontphobia</span></pre></div>
<p>The command shows the plan and asks before writing. It creates content-hashed WOFF2 files and replaces each original <code>@font-face</code> with core, extended and rest rules. The photos and JavaScript are unchanged.</p>
<details class="transcript"><summary>Full plan and verification output</summary><div class="term"><pre>${escape(report)}</pre></div></details>

<h3 id="verify">4. Check rendering, including the published copies</h3>
<p>The font verifier checks the files, word shaping and ${results.verification.comparisons.length} viewport/density comparisons in Chrome. It passed. A separate comparison of the actual original and optimized URLs found <strong>identical layout in all ${results.verification.publicComparisons.length} cases</strong>, with text pixels matching within one RGB level per colour channel, plus the filtered menu state.</p>
<p class="small-print">Photos are masked during pixel comparisons: Chrome can resample the same JPEG differently between loads. Their response bytes, positions and sizes match exactly. Photos remain visible and fully included in bandwidth measurements. The one-level text tolerance covers colour noise also observed between repeated captures with unchanged fonts. Strict and unmasked pixel counts are in the full results.</p>
<figure><a class="bakery-preview" href="bakery/after/menu.html" aria-label="Browse the optimized bakery menu"><img src="img/bakery-menu.jpg" width="1280" height="900" loading="lazy" alt="The bakery menu with a croissant photograph, search, category filters and a vegan-only checkbox."></a><figcaption>Try searching for “creme”, choosing Pastry, or turning on Vegan only in either version.</figcaption></figure>

<h3 id="verify-fail">What an optional trade-off looks like</h3>
<p>The deployed optimized copy uses the defaults. A separate build with <code>--allow limit-axes</code> saves another ${kb(results.limitAxes.saving)} across the active font files. Its verification ${results.limitAxes.ok ? 'passes within the allowed rounding' : 'fails'}; here is the measured menu diff.</p>
<figure class="diff-figure" style="${cropStyle}">
  <svg class="diff-filters" width="0" height="0" aria-hidden="true"><defs><filter id="diff-highlight" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="5" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="5" offset="0"/><feFuncB type="gamma" amplitude="1" exponent="5" offset="0"/></feComponentTransfer><feColorMatrix type="matrix" values="1 0 0 0 0  0 0.25 0.75 0 0  0 0 1 0 0  0 0 0 1 0"/></filter></defs></svg>
  <p class="diff-label">Detail: “Prices in euros.”</p>
  <div class="diff-detail"><img class="diff-highlight" src="img/verify-limit-axes.png" width="${image.width}" height="${image.height}" loading="lazy" alt="Magnified menu diff around the words Prices in euros, with changed pixels shown in orange."></div>
  <div class="legend"><span><i class="sw changed"></i>Changed pixels</span><span><i class="sw context"></i>Text for context</span></div>
  <details class="diff-full"><summary>Show the full diff</summary><a href="img/verify-limit-axes.png">Open the original PNG (${image.width} × ${image.height})</a><img class="diff-highlight" src="img/verify-limit-axes.png" width="${image.width}" height="${image.height}" loading="lazy" alt="Full menu diff from the separate limit-axes build, with changed pixels shown in orange."></details>
  <figcaption>Changed pixels from the current bakery's <code>limit-axes</code> build. Detail enlarged and contrast increased; the original uses yellow. Photos masked. Captured at 360 px and 2× density.</figcaption>
</figure>
<details class="transcript"><summary>Verification output with limit-axes</summary><div class="term"><pre>${escape(results.limitAxes.report)}</pre></div></details>

<h3 id="check">5. Keep it current</h3>
<p>Add <code>fontphobia check</code> after your build. It checks the fonts, CSS and built content without opening a browser. New text that loads the rest file produces a warning; <code>--strict</code> makes that fail the check.</p>
<p>The demo build is reproducible: <code>pnpm bakery:build</code> rebuilds both copies, reruns the measurements and updates this walkthrough. GitHub Pages checks their source and output hashes before publishing.</p>
<p><a href="bakery/report.txt">Download the build report</a> · <a href="bakery/font-files.json">Inspect the font files</a> · <a href="https://github.com/Amir-Abushanab/fontphobia/tree/main/examples/bakery">Source and photo credits</a></p>
<hr>

`;
  html = html.replace(/<h2 id="walkthrough">[\s\S]*?(?=<h2 id="beyond">)/, section);
  writeFileSync(path, html);
}
