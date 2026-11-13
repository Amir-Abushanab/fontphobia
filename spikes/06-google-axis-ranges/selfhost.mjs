// How much would self-hosting + fontphobia save vs Google's own latin slice?
import { readFileSync } from 'node:fs';
import { subset, woff2, load } from '../lib/hb.mjs';
import { fvar } from '../lib/sfnt.mjs';
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ASCII = range(0x20, 0x7e);
const PUNCT = [0xa0, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026];
for (const f of ['inter-wght-100-900.woff2', 'inter-full.woff2', 'flex-full.woff2']) {
  const g = new Uint8Array(readFileSync(new URL(`./fonts/${f}`, import.meta.url)));
  const src = await woff2.decompress(g);
  const { face } = load(src);
  const cmap = new Set(face.collectUnicodes());
  const feats = [...new Set([...face.getTableFeatureTags('GSUB'), ...face.getTableFeatureTags('GPOS')])].sort();
  const K = [...cmap].filter((c) => c >= 0x20); // safety net = whole latin slice (Google's latin slice ⊂ Latin-1 + punctuation)
  const core = [...ASCII, ...PUNCT].filter((c) => cmap.has(c));
  const sz = async (o) => (await woff2.compress(await subset(src, o))).length;
  const axes = fvar(src).axes;
  const pin = Object.fromEntries(axes.map((a) => [a.tag, a.tag === 'wght' ? 400 : a.def]));
  const pin7 = Object.fromEntries(axes.map((a) => [a.tag, a.tag === 'wght' ? 700 : a.def]));
  const row = {
    google: g.length,
    'same chars, HB-default features': await sz({ unicodes: K }),
    'core only (ASCII+punct)': await sz({ unicodes: core }),
    'core, all features kept': await sz({ unicodes: core, features: '*' }),
    'core + limit-axes wght 400..700': await sz({ unicodes: core, axes: { wght: { min: 400, max: 700 } } }),
    'core, pinned 400 + 700': (await sz({ unicodes: core, axes: pin })) + (await sz({ unicodes: core, axes: pin7 })),
  };
  console.log(
    `\n${f}  axes ${axes.map((a) => `${a.tag} ${a.min}-${a.max}`).join(', ')}  cmap ${cmap.size}  features ${feats.join(' ')}`,
  );
  for (const [k, v] of Object.entries(row))
    console.log(
      `  ${k.padEnd(34)} ${(v / 1024).toFixed(1).padStart(6)} KB  ${k === 'google' ? '' : (100 * (1 - v / row.google)).toFixed(0) + '% smaller'}`,
    );
}
