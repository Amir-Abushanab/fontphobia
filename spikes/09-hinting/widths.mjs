// Does dropping hinting change text widths (layout), not only pixels?
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
import { launch, dataUrl } from '../lib/browser.mjs';
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const LATIN = [...range(0x20, 0x7e), ...range(0xa0, 0xff)];
const TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
const browser = await launch({ args: process.argv.slice(2) });
const page = await browser.newPage();
let css = '';
for (const f of ['DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) {
  const src = await readSfnt(new URL(`../fonts/${f}`, import.meta.url).pathname);
  const k = f.split(/[-.]/)[0];
  css += `@font-face{font-family:${k}H;src:url(${dataUrl(await woff2.compress(await subset(src, { unicodes: LATIN })), 'font/woff2')})}`;
  css += `@font-face{font-family:${k}U;src:url(${dataUrl(await woff2.compress(await subset(src, { unicodes: LATIN, hinting: false })), 'font/woff2')})}`;
}
await page.setContent(`<style>${css} span{white-space:pre}</style><div id=h></div>`);
await page.evaluate(async () => { for (const f of document.fonts) await f.load(); });
const rows = [];
for (const k of ['DejaVuSans', 'Inter']) for (const size of [11, 13, 16, 24]) {
  const r = await page.evaluate(({ k, size, TEXT }) => ['H', 'U'].map((v) => { const s = document.createElement('span'); s.textContent = TEXT; s.style.cssText = `font-family:${k}${v};font-size:${size}px`; document.getElementById('h').append(s); return s.getBoundingClientRect().width; }), { k, size, TEXT });
  rows.push(`${k} ${size}px hinted ${r[0].toFixed(3)} unhinted Δ${(r[1] - r[0]).toFixed(3)}`);
}
console.log(browser.version(), process.platform, JSON.stringify(process.argv.slice(2)), '\n ' + rows.join('\n '));
await browser.close();
