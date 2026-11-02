// WOFF2 sizes for the cost of each "keep" option (Latin-1 subset).
import { subset, woff2, readSfnt } from '../lib/hb.mjs';
const LATIN = [];
for (let c = 0x20; c <= 0x7e; c++) LATIN.push(c);
for (let c = 0xa0; c <= 0xff; c++) LATIN.push(c);
const ids0to25 = Array.from({ length: 26 }, (_, i) => i);
for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) {
  const src = await readSfnt(new URL(`../fonts/${f}`, import.meta.url).pathname);
  const row = {};
  const cfg = {
    'default': {},
    'names 0-25': { nameIds: ids0to25 },
    'names *': { nameIds: '*', nameLangs: '*' },
    'features *': { features: '*' },
    'no hinting': { hinting: false },
  };
  if (f === 'InterVariable.ttf') Object.assign(cfg, { 'wght 400..700': { axes: { wght: { min: 400, max: 700 } } }, 'pin 400/14': { axes: { wght: 400, opsz: 14 } } });
  for (const [k, o] of Object.entries(cfg)) row[k] = (await woff2.compress(await subset(src, { unicodes: LATIN, ...o }))).length;
  console.log(f, JSON.stringify(row));
}
