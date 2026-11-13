// Accumulated advance drift over a long run of text after axis-range limiting.
import { subset, load, shape, setVars, readSfnt } from '../lib/hb.mjs';
const LATIN = [];
for (let c = 0x20; c <= 0x7e; c++) LATIN.push(c);
for (let c = 0xa0; c <= 0xff; c++) LATIN.push(c);
const text = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs! '.repeat(12);
const src = await readSfnt(new URL('../fonts/InterVariable.ttf', import.meta.url).pathname);
const orig = load(src);
for (const [label, axes] of Object.entries({
  'wght 400..700': { wght: { min: 400, max: 700 } },
  'wght 400..700 opsz 14..24': { wght: { min: 400, max: 700 }, opsz: { min: 14, max: 24 } },
})) {
  const sub = load(await subset(src, { unicodes: LATIN, axes }));
  for (let w = 400; w <= 700; w += 25)
    for (const o of [14, 16, 20, 24]) {
      setVars(orig.font, { wght: w, opsz: o });
      setVars(sub.font, { wght: w, opsz: o });
      const a = shape(orig.font, text),
        b = shape(sub.font, text);
      let sa = 0,
        sb = 0,
        maxRun = 0;
      for (let i = 0; i < a.length; i++) {
        sa += a[i].ax;
        sb += b[i].ax;
        maxRun = Math.max(maxRun, Math.abs(sa - sb));
      }
      if (maxRun)
        console.log(
          label.padEnd(26),
          `wght ${w} opsz ${o}`.padEnd(18),
          `${a.length} glyphs, max cumulative drift ${maxRun} units = ${((maxRun / 2048) * 16).toFixed(3)} px @16px, ${((maxRun / 2048) * 64).toFixed(3)} px @64px`,
        );
    }
}
