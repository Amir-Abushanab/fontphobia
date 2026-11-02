// Spike 2: Chrome's behavior when one family is split across unicode-range files.
//  - kerning / contextual alternates across the core|extended boundary
//  - a core base letter + combining mark that lives in extended
//  - which files are downloaded for which text
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
import { launch } from '../lib/browser.mjs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ASCII = range(0x20, 0x7e);
const MARKS = range(0x300, 0x36f);
const EXT = [...range(0xa0, 0x17f), ...MARKS, 0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026];
const hex = (a) => a.map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0')).join(',');

const src = await readSfnt(new URL('../fonts/InterVariable.ttf', import.meta.url).pathname);
const files = {
  'whole.woff2': await woff2.compress(await subset(src, { unicodes: [...ASCII, ...EXT] })),
  'core.woff2': await woff2.compress(await subset(src, { unicodes: ASCII })),
  'ext.woff2': await woff2.compress(await subset(src, { unicodes: EXT })),
  'coremarks.woff2': await woff2.compress(await subset(src, { unicodes: [...ASCII, ...MARKS] })),
  'extnomarks.woff2': await woff2.compress(await subset(src, { unicodes: EXT.filter((c) => !MARKS.includes(c)) })),
};

const face = (fam, file, ur) => `@font-face{font-family:${fam};src:url(/${file}) format('woff2');font-weight:100 900;font-display:block${ur ? `;unicode-range:${ur}` : ''}}`;
const css = [
  face('Whole', 'whole.woff2'),
  face('Split', 'core.woff2', hex(ASCII)), face('Split', 'ext.woff2', hex(EXT)),
  face('SplitM', 'coremarks.woff2', hex([...ASCII, ...MARKS])), face('SplitM', 'extnomarks.woff2', hex(EXT.filter((c) => !MARKS.includes(c)))),
].join('\n');

const CASES = {
  'kern core|core (control)': 'AVATAR To We Yo',
  'kern core|ext': 'Tö Vä Yö Wå Tü Fä Pö',
  'kern ext|core': 'Äv Öy Åw ÜT',
  'calt core colon between ext caps': 'Ä:Ö Ü:Å',
  'calt core only (control)': 'A:B 12:30 ->',
  'precomposed é (ext)': 'café naïve',
  'decomposed e+U+0301 (core+ext)': 'café naïve',
  'decomposed ext base + mark': 'ä́ ọ̈',
  'curly quotes ext around core': '“Too” ‘yo’',
};

const browser = await launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx.newPage();
const requested = [];
await page.route('http://fonts.test/**', (route) => {
  const name = new URL(route.request().url()).pathname.slice(1);
  if (name === '') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><style>${css} body{margin:0} div{font-size:48px;white-space:pre;padding:4px 8px;display:inline-block}</style><body>` });
  requested.push(name);
  return route.fulfill({ contentType: 'font/woff2', body: Buffer.from(files[name]) });
});
await page.goto('http://fonts.test/');
console.log('chrome', browser.version());
console.log('sizes', Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])));

const outDir = new URL('./shots/', import.meta.url).pathname; mkdirSync(outDir, { recursive: true });
let n = 0;
for (const [label, text] of Object.entries(CASES)) {
  const res = {};
  const shots = {};
  for (const fam of ['Whole', 'Split', 'SplitM']) {
    requested.length = 0;
    await page.evaluate(async ({ fam, text }) => {
      document.body.innerHTML = '';
      const d = document.createElement('div'); d.id = 'x'; d.style.fontFamily = fam; d.textContent = text; document.body.append(d);
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, { fam, text });
    res[fam] = { w: await page.evaluate(() => document.getElementById('x').getBoundingClientRect().width), files: [...requested] };
    shots[fam] = PNG.sync.read(await page.locator('#x').screenshot());
  }
  const diff = (a, b) => {
    if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} vs ${b.width}x${b.height}`;
    const out = new PNG({ width: a.width, height: a.height });
    const px = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0 });
    if (px) writeFileSync(`${outDir}${String(++n).padStart(2, '0')}-${label.replace(/\W+/g, '_')}.png`, PNG.sync.write(out));
    return `${px} px`;
  };
  console.log(`\n${label}: ${JSON.stringify(text)}`);
  console.log(`  width  Whole ${res.Whole.w.toFixed(2)}  Split Δ${(res.Split.w - res.Whole.w).toFixed(2)}  SplitM Δ${(res.SplitM.w - res.Whole.w).toFixed(2)}`);
  console.log(`  pixels Split ${diff(shots.Whole, shots.Split)}   SplitM ${diff(shots.Whole, shots.SplitM)}`);
  console.log(`  fetched (new this case) Split ${JSON.stringify(res.Split.files)} SplitM ${JSON.stringify(res.SplitM.files)}`);
}

// Download behavior on a fresh page: core-only text should fetch only core.
for (const [label, text] of Object.entries({ 'ascii only': 'Hello world', 'one é': 'café', 'combining only': 'café' })) {
  const p = await ctx.newPage();
  const got = [];
  await p.route('http://fonts.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === '') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><style>${css}</style><div style="font-family:Split">${text}</div><div style="font-family:SplitM">${text}</div>` });
    got.push(name);
    return route.fulfill({ contentType: 'font/woff2', body: Buffer.from(files[name]) });
  });
  await p.goto('http://fonts.test/');
  await p.evaluate(() => document.fonts.ready);
  console.log(`\nfresh page "${label}": fetched ${JSON.stringify(got.sort())}`);
  await p.close();
}
await browser.close();
