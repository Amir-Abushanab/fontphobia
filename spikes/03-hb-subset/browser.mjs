// Does the HarfBuzz advance drift from axis-range limiting show up in Chrome's text widths?
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
import { launch, dataUrl } from '../lib/browser.mjs';
const LATIN = [];
for (let c = 0x20; c <= 0x7e; c++) LATIN.push(c);
for (let c = 0xa0; c <= 0xff; c++) LATIN.push(c);
const text = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs! '.repeat(12);
const src = await readSfnt(new URL('../fonts/InterVariable.ttf', import.meta.url).pathname);
const fonts = {
  orig: src,
  latin: await subset(src, { unicodes: LATIN }),
  wght: await subset(src, { unicodes: LATIN, axes: { wght: { min: 400, max: 700 } } }),
  wghtOpsz: await subset(src, { unicodes: LATIN, axes: { wght: { min: 400, max: 700 }, opsz: { min: 14, max: 24 } } }),
  noHVAR: await subset(
    await subset(src, { unicodes: LATIN, axes: { wght: { min: 400, max: 700 }, opsz: { min: 14, max: 24 } } }),
    { dropTables: ['HVAR'] },
  ),
};
const css = (
  await Promise.all(
    Object.entries(fonts).map(
      async ([k, b]) =>
        `@font-face{font-family:${k};src:url(${dataUrl(await woff2.compress(b), 'font/woff2')}) format('woff2');font-weight:100 900}`,
    ),
  )
).join('\n');
const browser = await launch();
const page = await browser.newPage();
await page.setContent(`<style>${css} span{white-space:pre;font-size:16px}</style><div id=h></div>`);
page.on('console', (m) => console.log('console:', m.text()));
console.log(
  'load',
  await page.evaluate(() =>
    Promise.all(
      ['orig', 'latin', 'wght', 'wghtOpsz', 'noHVAR'].map((f) =>
        document.fonts.load(`16px ${f}`).then(
          (r) => f + ':' + r.length,
          (e) => f + ':' + e.message,
        ),
      ),
    ),
  ),
);
console.log('chrome', browser.version());
const coords = [
  [400, 14],
  [400, 20],
  [425, 14],
  [550, 24],
  [650, 14],
  [700, 20],
  [700, 24],
];
for (const size of [16, 64])
  for (const [w, o] of coords) {
    const r = await page.evaluate(
      ({ text, w, o, size }) => {
        const h = document.getElementById('h');
        h.innerHTML = '';
        const out = {};
        for (const f of ['orig', 'latin', 'wght', 'wghtOpsz', 'noHVAR']) {
          const s = document.createElement('span');
          s.textContent = text;
          s.style.fontFamily = f;
          s.style.fontSize = size + 'px';
          s.style.fontVariationSettings = `'wght' ${w}, 'opsz' ${o}`;
          h.append(s, document.createElement('br'));
          out[f] = s.getBoundingClientRect().width;
        }
        return out;
      },
      { text, w, o, size },
    );
    const d = (k) => (r[k] - r.orig).toFixed(3).padStart(8);
    console.log(
      `${size}px wght ${w} opsz ${o}`.padEnd(22),
      `orig ${r.orig.toFixed(3)}  Δlatin ${d('latin')}  Δwght ${d('wght')}  Δwght+opsz ${d('wghtOpsz')}  Δ…noHVAR ${d('noHVAR')}`,
    );
  }
await browser.close();
