// Hashes of HarfBuzz subset + wawoff2 output for fixed inputs. Compare across OS/arch/Node.
import { createHash } from 'node:crypto';
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const LATIN = [];
for (let c = 0x20; c <= 0x7e; c++) LATIN.push(c);
for (let c = 0xa0; c <= 0xff; c++) LATIN.push(c);
const out = { node: process.version, platform: `${process.platform}-${process.arch}` };
for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) {
  const src = await readSfnt(new URL(`../fonts/${f}`, import.meta.url).pathname);
  out[`${f} decoded`] = h(src);
  const cfgs = { latin: { unicodes: LATIN }, nohint: { unicodes: LATIN, hinting: false }, all: {} };
  if (f.startsWith('InterVariable'))
    Object.assign(cfgs, {
      range: { unicodes: LATIN, axes: { wght: { min: 400, max: 700 }, opsz: { min: 14, max: 24 } } },
      pin: { unicodes: LATIN, axes: { wght: 550, opsz: 20 } },
    });
  for (const [k, o] of Object.entries(cfgs)) {
    const s = await subset(src, o);
    const w = await woff2.compress(s);
    const back = await woff2.decompress(w);
    out[`${f} ${k}`] = `sfnt ${h(s)} woff2 ${h(w)} (${w.length} B) roundtrip ${h(back) === h(s) ? 'same' : h(back)}`;
  }
}
console.log(JSON.stringify(out, null, 1));
