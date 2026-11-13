// Is a pinned (static) instance exact in Chrome at its coordinate?
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
import { launch, dataUrl } from '../lib/browser.mjs';
const LATIN = [];
for (let c = 0x20; c <= 0x7e; c++) LATIN.push(c);
for (let c = 0xa0; c <= 0xff; c++) LATIN.push(c);
const text = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs! '.repeat(12);
const src = await readSfnt(new URL('../fonts/InterVariable.ttf', import.meta.url).pathname);
const coords = [
  [400, 14],
  [400, 16],
  [550, 24],
  [650, 14],
  [700, 20],
  [700, 24],
];
let css = `@font-face{font-family:orig;src:url(${dataUrl(await woff2.compress(src), 'font/woff2')});font-weight:100 900}`;
for (const [w, o] of coords)
  css += `@font-face{font-family:p${w}_${o};src:url(${dataUrl(await woff2.compress(await subset(src, { unicodes: LATIN, axes: { wght: w, opsz: o } })), 'font/woff2')})}`;
const browser = await launch();
const page = await browser.newPage();
await page.setContent(`<style>${css} span{white-space:pre}</style><div id=h></div>`);
await page.evaluate(async () => {
  for (const f of document.fonts) await f.load();
});
console.log('chrome', browser.version());
for (const size of [16, 64])
  for (const [w, o] of coords) {
    const r = await page.evaluate(
      ({ text, w, o, size }) => {
        const h = document.getElementById('h');
        h.innerHTML = '';
        const mk = (fam, fvs) => {
          const s = document.createElement('span');
          s.textContent = text;
          s.style.cssText = `font-family:${fam};font-size:${size}px;${fvs}`;
          h.append(s, document.createElement('br'));
          return s.getBoundingClientRect().width;
        };
        return { orig: mk('orig', `font-variation-settings:'wght' ${w},'opsz' ${o}`), pin: mk(`p${w}_${o}`, '') };
      },
      { text, w, o, size },
    );
    console.log(
      `${size}px wght ${w} opsz ${o}`.padEnd(22),
      `orig ${r.orig.toFixed(3)}  Δpinned ${(r.pin - r.orig).toFixed(3)}`,
    );
  }
await browser.close();
