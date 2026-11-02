// Decompresses each downloaded WOFF2 and prints axes, avar, metrics, glyph
// count, cmap size and advance widths at several wght values.
// fontkit's getVariation() is broken on WOFF2, so decompress with wawoff2 first.
import { readFileSync, readdirSync } from 'node:fs';
import { decompress } from 'wawoff2';
import * as fontkit from 'fontkit';

const dir = new URL('./fonts/', import.meta.url);
const files = [
  ...readdirSync(dir).filter((f) => f.endsWith('.woff2')).map((f) => new URL(f, dir)),
  ...readdirSync(new URL('./variants/', dir)).filter((f) => f.endsWith('.woff2')).map((f) => new URL(`variants/${f}`, dir)),
];
const TEXT = 'Hamburgefonstiv';

const out = {};
for (const url of files) {
  const name = url.pathname.split('/fonts/')[1];
  const sfnt = Buffer.from(await decompress(readFileSync(url)));
  const f = fontkit.create(sfnt);
  const axes = Object.fromEntries(Object.entries(f.variationAxes).map(([k, a]) => [k, `${a.min}..${a.max} (def ${a.default})`]));
  const tables = Object.keys(f.directory.tables).sort();
  const avar = f.avar ? f.avar.segment.map((s) => s.correspondence.length) : null;
  const adv = {};
  for (const w of [400, 550, 700]) {
    if (!f.variationAxes.wght) { adv[w] = f.layout(TEXT).advanceWidth; continue; }
    const coords = { wght: w };
    if (f.variationAxes.opsz) coords.opsz = 16;
    adv[w] = f.getVariation(coords).layout(TEXT).advanceWidth;
  }
  out[name] = {
    sfntBytes: sfnt.length,
    numGlyphs: f.numGlyphs,
    cmapCount: f.characterSet.length,
    axes,
    avarSegmentLengths: avar,
    hhea: [f.hhea.ascent, f.hhea.descent, f.hhea.lineGap],
    os2: [f['OS/2'].typoAscender, f['OS/2'].typoDescender, f['OS/2'].typoLineGap, f['OS/2'].winAscent, f['OS/2'].winDescent],
    unitsPerEm: f.unitsPerEm,
    hasHinting: tables.some((t) => ['fpgm', 'prep', 'cvt '].includes(t)),
    tables: tables.join(' '),
    advance: adv,
    nameVersion: f.version,
  };
}
console.log(JSON.stringify(out, null, 1));
