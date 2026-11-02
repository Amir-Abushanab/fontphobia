// Renders the same text with pairs of Google Fonts files in Chrome and
// pixel-diffs them. Each pair answers: does swapping the file change pixels
// for axis values inside the requested range?
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const F = (p) => readFileSync(new URL(`./fonts/${p}`, import.meta.url)).toString('base64');
const fonts = {
  interFull: F('inter-full.woff2'),
  interWght: F('inter-wght-400-700.woff2'),
  interStatic400: F('inter-wght-400.woff2'),
  flexFull: F('flex-full.woff2'),
  flexWghtStatic: F('variants/Roboto_Flex_wght_400__700-4df81e50.woff2'), // /s/ URL: full wght range
  flexWghtDynamic: F('variants/Roboto_Flex_wght_400__700-8f5f39e4.woff2'), // /l/font URL: instanced 400..700
};
const TEXT = 'Hamburgefonstiv 0123456789 The quick brown fox jumps over the lazy dog. Ünïcödé “quotes” — fi fl';

// [label, fontA, fontB, css for the element]
const cases = [];
for (const size of [14, 16, 24]) for (const w of [400, 550, 700])
  cases.push([`inter full vs wght-only  ${size}px wght ${w} opsz auto`, 'interFull', 'interWght', `font-size:${size}px;font-weight:${w};font-optical-sizing:auto`]);
for (const w of [400, 550, 700])
  cases.push([`inter full@opsz14 vs wght-only 16px wght ${w}`, 'interFull', 'interWght', `font-size:16px;font-weight:${w};font-variation-settings:'opsz' 14`]);
cases.push(['inter wght-only vs static wght@400  16px 400', 'interWght', 'interStatic400', 'font-size:16px;font-weight:400']);
for (const w of [400, 550, 700])
  cases.push([`flex /s/ full-range vs /l/ instanced 16px wght ${w}`, 'flexWghtStatic', 'flexWghtDynamic', `font-size:16px;font-weight:${w}`]);
for (const size of [14, 16, 24])
  cases.push([`flex full vs wght-only  ${size}px wght 400 opsz auto`, 'flexFull', 'flexWghtStatic', `font-size:${size}px;font-weight:400;font-optical-sizing:auto`]);

const faces = Object.entries(fonts).map(([k, b]) => `@font-face{font-family:${k};src:url(data:font/woff2;base64,${b}) format('woff2');font-weight:100 1000}`).join('\n');
const html = `<!doctype html><html><head><style>${faces}
body{margin:0;background:#fff;color:#000}
div{width:900px;padding:4px;white-space:nowrap;overflow:hidden;line-height:1.4}
</style></head><body><div id=t></div></body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 200 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.evaluate(async (names) => { for (const n of names) await document.fonts.load(`16px ${n}`); }, Object.keys(fonts));
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });

const shot = async (family, css) => {
  await page.evaluate(([family, css, text]) => {
    const t = document.getElementById('t');
    t.setAttribute('style', `font-family:${family};${css}`);
    t.textContent = text;
  }, [family, css, TEXT]);
  return PNG.sync.read(await page.locator('#t').screenshot());
};

const results = [];
for (const [label, a, b, css] of cases) {
  const A = await shot(a, css), B = await shot(b, css);
  const diff = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, diff.data, A.width, A.height, { threshold: 0 });
  results.push({ label, css, diffPixels: n });
  if (n) writeFileSync(new URL(`./out/${label.replace(/[^a-z0-9]+/gi, '-')}.png`, import.meta.url), PNG.sync.write(diff));
  console.log(label.padEnd(56), String(n).padStart(6), 'px differ');
}
writeFileSync(new URL('./out/results.json', import.meta.url), JSON.stringify({ chrome: browser.version(), results }, null, 2));
await browser.close();
