// Rebuild the published comparison from one source tree and measure the finished pages.
// Run from the repository root: pnpm bakery:build (requires installed Google Chrome).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { audit, launchChrome, serveStatic, verify, formatVerify } from '../packages/crawler/src/index.ts';
import { buildProject, checkProject, detectCss, formatPlan, inspectFont, otherFaces, readManifest, writeManifest } from '../packages/core/src/index.ts';
import { filesIn, sha256, sourceFingerprint } from './bakery-files.mjs';
import { refreshWalkthrough } from './bakery-walkthrough.mjs';

const require = createRequire(new URL('../packages/crawler/package.json', import.meta.url));
const { PNG } = require('pngjs');
const pixelmatch = (await import(pathToFileURL(require.resolve('pixelmatch')))).default;
const repo = fileURLToPath(new URL('../', import.meta.url));
const source = join(repo, 'examples/bakery');
const sourceSnapshot = sourceFingerprint(source);
const output = join(repo, 'site/bakery');
const temp = mkdtempSync(join(tmpdir(), 'fontphobia-bakery-'));
const optimized = join(temp, 'optimized');
const limited = join(temp, 'limited');
const version = JSON.parse(readFileSync(join(repo, 'packages/cli/package.json'), 'utf8')).version;
const log = (message) => process.stdout.write(`${message}\n`);
const pages = ['/', '/menu.html', '/about.html', '/journal/levain.html'];
const viewports = [360, 768, 1280, 1920];
// Repeated captures with the very same fonts vary by one RGB level on macOS.
// Positions/sizes must match exactly; retain strict counts and ignore only that colour noise.
function textPixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Text layout dimensions differ.');
  let pixels = 0, strictPixels = 0, maxChannelDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]));
    if (delta) strictPixels++;
    if (delta > 1) pixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { pixels, strictPixels, maxChannelDelta, channelTolerance: 1 };
}
let browser, server;

try {
  cpSync(source, optimized, { recursive: true });
  log('Auditing the complete bakery: four pages, photos, emoji, menu controls.');
  const audited = await audit({ root: optimized, dist: '.', fontphobiaVersion: version, viewports, cache: false, ignore: ['/index.html'], log });
  const built = await buildProject(optimized, audited.usage, {}, { version, write: true });
  if (built.notWritten.length) throw new Error(JSON.stringify(built.notWritten));
  const checked = await checkProject({ root: optimized, usage: audited.usage });
  if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
  // Photograph resampling can differ between Chrome loads. Test text pixels with images
  // masked, then independently check the published image bodies and exact layout below.
  const verified = await verify({ root: optimized, dist: '.', usage: audited.usage, viewports, dprs: [1, 2], mask: ['img'], log });
  log(formatVerify(verified, optimized));
  if (!verified.ok) throw new Error('The bakery does not render equivalently after subsetting.');

  // Both versions use the same source HTML, images, JS and comparison toolbar.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(join(source, 'images'), join(output, 'images'), { recursive: true });
  cpSync(join(optimized, 'fonts'), join(output, 'fonts'), { recursive: true });
  cpSync(join(source, 'bakery.js'), join(output, 'bakery.js'));
  const comparisonCss = `.comparison-bar{font:12px/1.5 system-ui,sans-serif;background:#e8e4d8;color:#292820;border-bottom:1px solid #ccc6b6;padding:10px 20px;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px 20px}.comparison-bar a{color:inherit;text-underline-offset:3px;padding:4px 0}.comparison-bar [aria-current=page]{font-weight:700;text-decoration-thickness:2px}.comparison-bar strong{font-weight:600}.comparison-bar a:focus-visible{outline:2px solid #a64024;outline-offset:3px}\n`;
  writeFileSync(join(output, 'comparison.css'), comparisonCss);
  const htmlFiles = filesIn(source).filter((file) => file.endsWith('.html'));
  for (const mode of ['before', 'after']) {
    for (const file of htmlFiles) {
      const path = relative(source, file).split('\\').join('/');
      const up = path.includes('/') ? '../' : '';
      const bar = `<aside class="comparison-bar" aria-label="Font comparison"><strong>Fictional bakery · fontphobia demo</strong><a data-version-link href="${up}../before/${path}"${mode === 'before' ? ' aria-current="page"' : ''}>Original fonts</a><a data-version-link href="${up}../after/${path}"${mode === 'after' ? ' aria-current="page"' : ''}>Optimized fonts</a><a href="${up}../../index.html#walkthrough">Measurements &amp; walkthrough</a></aside>`;
      let html = readFileSync(file, 'utf8').replace('<!-- bakery:comparison-bar -->', bar)
        .replace('</head>', `<link rel="stylesheet" href="${up}../comparison.css">\n</head>`)
        .replace(`src="${up}bakery.js"`, `src="${up}../bakery.js"`)
        .replace(/(?:\.\.\/)?images\//g, `${up}../images/`);
      const target = join(output, mode, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html);
    }
    const css = readFileSync(join(mode === 'before' ? source : optimized, 'styles.css'), 'utf8')
      .replaceAll("url('./fonts/", "url('../fonts/");
    writeFileSync(join(output, mode, 'styles.css'), css);
  }

  const faces = [];
  for (const entry of Object.values(built.manifest.entries)) {
    const original = await inspectFont(new Uint8Array(readFileSync(join(source, entry.source.file))));
    const plan = built.plan.faces.find((face) => face.id === entry.id);
    faces.push({ family: entry.family, used: audited.usage.faces[entry.id].count,
      source: { file: entry.source.file, bytes: entry.source.bytes, characters: original.unicodes.count },
      outputs: entry.outputs.map(({ role, file, bytes, sha256, unicodeRange }) => ({ role, file, bytes, sha256, unicodeRange })),
      repair: plan.repair, optIns: plan.optIns });
  }
  writeFileSync(join(output, 'font-files.json'), JSON.stringify({ faces }, null, 2) + '\n');
  const report = `${formatPlan(built.plan, audited.usage)}\n\n${formatVerify(verified, optimized)}`;
  writeFileSync(join(output, 'report.txt'), report.replaceAll(temp, '<temporary build>'));

  // Recreate the optional, rendering-changing build for the walkthrough's real diff.
  cpSync(source, limited, { recursive: true });
  const limitedBuild = await buildProject(limited, audited.usage, { allow: ['limit-axes'] }, { version, write: true });
  const limitedVerify = await verify({ root: limited, dist: '.', usage: audited.usage, viewports: [360], dprs: [2], mask: ['img'], log });
  const diff = limitedVerify.browser?.comparisons.find((c) => c.page === '/menu.html' && c.diffImage);
  if (!diff) throw new Error('No measured menu diff was produced for the optional limit-axes example.');
  cpSync(diff.diffImage, join(repo, 'site/img/verify-limit-axes.png'));
  const diffPng = PNG.sync.read(readFileSync(diff.diffImage));

  server = await serveStatic(join(repo, 'site'), { base: '/fontphobia/' });
  browser = await launchChrome();
  const measurements = [];
  const publicComparisons = [];
  const states = [];
  let crop;
  async function capture(mode, path, width, dpr) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: dpr, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const pending = [];
    const resources = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      pending.push((async () => {
        if (response.status() >= 400) throw new Error(`${response.status()}: ${response.url()}`);
        const bytes = await response.body();
        resources.push({ path: new URL(response.url()).pathname.replace('/fontphobia/bakery/', '').replace(`${mode}/`, ''), type: response.request().resourceType(), bytes: bytes.length, sha256: sha256(bytes) });
      })());
    });
    await page.goto(`${server.url}bakery/${mode}${path}`, { waitUntil: 'load' });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.evaluate(async () => {
      for (const image of document.images) image.loading = 'eager';
      await Promise.all([...document.images].map((image) => image.decode()));
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForLoadState('networkidle');
    await Promise.all(pending);
    if (errors.length) throw new Error(errors.join('\n'));
    const broken = await page.evaluate(() => [...document.images].filter((image) => !image.naturalWidth).length);
    if (broken) throw new Error(`Broken photos on ${mode}${path}`);
    const fonts = resources.filter((r) => r.type === 'font');
    return { context, page, resources, fontBytes: fonts.reduce((n, r) => n + r.bytes, 0), fontRequests: fonts.length, totalBytes: resources.reduce((n, r) => n + r.bytes, 0), requests: resources.length };
  }
  for (const width of [390, 1280]) for (const dpr of [1, 2]) for (const path of pages) {
    log(`Measuring published pair: ${path} at ${width}px, DPR ${dpr}`);
    const before = await capture('before', path, width, dpr);
    const after = await capture('after', path, width, dpr);
    try {
      const assets = (result) => result.resources.filter((r) => r.type === 'image' || r.type === 'script').sort((a, b) => a.path.localeCompare(b.path));
      if (JSON.stringify(assets(before)) !== JSON.stringify(assets(after))) throw new Error(`Images/scripts differ on ${path}`);
      const imageGeometry = (page) => page.evaluate(() => {
        const main = document.querySelector('main').getBoundingClientRect();
        return [...document.querySelectorAll('main img')].map((image) => { const r = image.getBoundingClientRect(); return { src: image.currentSrc, x: r.x - main.x, y: r.y - main.y, width: r.width, height: r.height }; });
      });
      if (JSON.stringify(await imageGeometry(before.page)) !== JSON.stringify(await imageGeometry(after.page))) throw new Error(`Image layout differs on ${path}`);
      const rawBefore = PNG.sync.read(await before.page.locator('main').screenshot());
      const rawAfter = PNG.sync.read(await after.page.locator('main').screenshot());
      const unmaskedPixels = rawBefore.width === rawAfter.width && rawBefore.height === rawAfter.height ? pixelmatch(rawBefore.data, rawAfter.data, undefined, rawBefore.width, rawBefore.height, { threshold: 0, includeAA: true }) : -1;
      const masks = await Promise.all([before, after].map((result) => result.page.addStyleTag({ content: 'main img{visibility:hidden!important}' })));
      const a = PNG.sync.read(await before.page.locator('main').screenshot());
      const b = PNG.sync.read(await after.page.locator('main').screenshot());
      if (a.width !== b.width || a.height !== b.height) throw new Error(`Layout mismatch: ${path}`);
      const comparison = textPixels(a, b);
      if (comparison.pixels) throw new Error(`${comparison.pixels} pixels differ beyond one RGB level in the published pair: ${path} at ${width}/${dpr}`);
      publicComparisons.push({ page: path, viewport: width, dpr, ...comparison, unmaskedPixels, mask: 'photographs only', imageBodiesIdentical: true, imageGeometryIdentical: true });
      const numbers = ({ fontBytes, fontRequests, totalBytes, requests }) => ({ fontBytes, fontRequests, totalBytes, requests });
      measurements.push({ page: path, viewport: width, dpr, before: numbers(before), after: numbers(after), resources: { before: before.resources, after: after.resources } });
      if (width === 1280 && dpr === 1 && (path === '/' || path === '/menu.html')) {
        await masks[1].evaluate((element) => element.remove());
        await after.page.screenshot({ path: join(repo, `site/img/bakery-${path === '/' ? 'home' : 'menu'}.jpg`), type: 'jpeg', quality: 85 });
      }
      if (width === 390 && dpr === 2 && path === '/menu.html') {
        for (const result of [before, after]) {
          await result.page.locator('#menu-search').fill('creme');
          await result.page.waitForTimeout(250);
        }
        const a = PNG.sync.read(await before.page.locator('main').screenshot());
        const b = PNG.sync.read(await after.page.locator('main').screenshot());
        const comparison = textPixels(a, b);
        if (comparison.pixels) throw new Error('The filtered menu differs between published versions.');
        states.push({ page: path, state: 'accent-insensitive search: creme', ...comparison });
      }
    } finally { await before.context.close(); await after.context.close(); }
  }
  // Match the coordinate system of verify's 360 px / DPR 2 screenshot.
  const limitedServer = await serveStatic(limited);
  const detail = await browser.newPage({ viewport: { width: 360, height: 900 }, deviceScaleFactor: 2 });
  try {
    await detail.goto(`${limitedServer.url}menu.html`);
    await detail.evaluate(() => document.fonts.ready);
    crop = await detail.locator('#diff-phrase').evaluate((element) => { const r = element.getBoundingClientRect(); return { x: Math.max(0, Math.floor((r.x - 8) * 2)), y: Math.max(0, Math.floor((r.y + scrollY - 8) * 2)), width: Math.ceil((r.width + 16) * 2), height: Math.ceil((r.height + 16) * 2) }; });
  } finally { await detail.close(); await limitedServer.close(); }
  const generatedFiles = Object.fromEntries(filesIn(output).map((file) => [relative(output, file).split('\\').join('/'), sha256(readFileSync(file))]));
  const results = {
    schema: 1, measuredAt: new Date().toISOString(), fontphobia: version, chrome: browser.version(), source: sourceSnapshot, generatedFiles,
    methodology: { cache: 'fresh browser context per page and version', images: 'all images loaded, including lazy images', bytes: 'response body bytes; excludes HTTP headers, TLS and gzip savings on HTML/CSS/JS', baseline: 'self-hosted full Inter variable WOFF2 and Google Latin Fraunces WOFF2', emoji: 'system emoji font, identical in both versions; no downloaded emoji font', opts: 'defaults only; no limit-axes, hinting removal or split-shaping' },
    pages: measurements, faces, verification: { ok: verified.ok, mask: ['img'], explanation: 'Photographs are masked for text-pixel checks because Chrome can resample the same JPEG differently between loads. Image response hashes and exact image positions/sizes are checked separately. Published-copy text comparisons tolerate one RGB level per channel, observed between repeat captures with unchanged fonts; strict pixel counts and raw unmasked counts are retained.', comparisons: verified.browser.comparisons.map(({ page, viewport, dpr, class: result, pixels }) => ({ page, viewport, dpr, result, pixels })), publicComparisons, states },
    limitAxes: { ok: limitedVerify.ok, saving: limitedBuild.plan.faces.reduce((n, face) => n + (face.optIns?.find((o) => o.id === 'limit-axes')?.saving ?? 0), 0), report: formatVerify(limitedVerify, limited).replaceAll(temp, '<temporary build>'), image: { width: diffPng.width, height: diffPng.height, crop } },
  };
  if (sourceFingerprint(source).sha256 !== sourceSnapshot.sha256) throw new Error('The bakery source changed during measurement; rerun the build.');
  writeFileSync(join(output, 'measurements.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(output, 'README.md'), '# Published bakery comparison\n\nGenerated from examples/bakery by `pnpm bakery:build`. Do not edit these copies by hand. See measurements.json for inputs, file hashes, all resource sizes, and verification results.\n');
  refreshWalkthrough(repo, results, report);
  // The original demo faces intentionally stay whole; register them as untouched
  // declarations so the walkthrough's own `check` still notices future edits.
  const walkthroughRoot = join(repo, 'site');
  const walkthroughManifest = readManifest(walkthroughRoot);
  if (walkthroughManifest) {
    walkthroughManifest.others = otherFaces(walkthroughRoot, detectCss(walkthroughRoot));
    writeManifest(walkthroughRoot, walkthroughManifest);
  }
  log(`Published example generated. ${publicComparisons.length} physical before/after comparisons match text within one RGB level, and have identical layout and image bodies.`);
} finally {
  await browser?.close();
  await server?.close();
  rmSync(temp, { recursive: true, force: true });
}
