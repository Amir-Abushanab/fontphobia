// Spike 9: does a pixel diff detect hinting removal? Run on macOS (control) and in Linux
// containers with different fontconfig / FreeType settings.
// usage: node run.mjs <label> [--bundled] [chrome flags...]
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
import { chromium } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const [label = 'local', ...rest] = process.argv.slice(2);
const bundled = rest.includes('--bundled');
const args = rest.filter((a) => a !== '--bundled');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const LATIN = [...range(0x20, 0x7e), ...range(0xa0, 0xff)];
const TEXT = 'Hamburgefonstiv 0123456789 The quick brown fox jumps over the lazy dog.';
const SIZES = [10, 11, 12, 13, 14, 16, 18, 24];
const fonts = {};
for (const f of ['DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) {
  const src = await readSfnt(new URL(`../fonts/${f}`, import.meta.url).pathname);
  fonts[f] = {
    hinted: Buffer.from(await woff2.compress(await subset(src, { unicodes: LATIN }))).toString('base64'),
    unhinted: Buffer.from(await woff2.compress(await subset(src, { unicodes: LATIN, hinting: false }))).toString(
      'base64',
    ),
  };
}
const browser = await chromium.launch({ headless: true, ...(bundled ? {} : { channel: 'chrome' }), args });
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 900, height: 400 } });
const outDir = new URL(`./shots/${label}/`, import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const result = {
  label,
  chrome: browser.version(),
  platform: `${process.platform}-${process.arch}`,
  args,
  env: { FONTCONFIG_FILE: process.env.FONTCONFIG_FILE, FREETYPE_PROPERTIES: process.env.FREETYPE_PROPERTIES },
  diffs: {},
};
for (const [f, v] of Object.entries(fonts)) {
  const shot = async (which) => {
    await page.setContent(
      `<style>@font-face{font-family:T;src:url(data:font/woff2;base64,${v[which]})}body{margin:0;background:#fff;color:#000;font-family:T}p{margin:0 4px;white-space:nowrap}</style>${SIZES.map((s) => `<p style="font-size:${s}px">${TEXT}</p>`).join('')}`,
    );
    await page.evaluate(() => document.fonts.ready);
    return PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: 900, height: 160 } }));
  };
  const a = await shot('hinted'),
    b = await shot('unhinted');
  const out = new PNG({ width: a.width, height: a.height });
  const px = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0 });
  // width check: does hinting change advances (layout), not just pixels?
  writeFileSync(`${outDir}${f}-hinted.png`, PNG.sync.write(a));
  writeFileSync(`${outDir}${f}-unhinted.png`, PNG.sync.write(b));
  if (px) writeFileSync(`${outDir}${f}-diff.png`, PNG.sync.write(out));
  result.diffs[f] = px;
}
await browser.close();
console.log(JSON.stringify(result));
