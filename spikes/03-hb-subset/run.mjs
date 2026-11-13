// Spike 3: what HarfBuzz's subsetter/instancer changes besides the glyph set.
//  a) Outlines/advances after axis limiting or pinning vs the original at the same coordinates.
//  b) OS/2 / hhea / head metrics (raw tables + MVAR-applied extents).
//  c) Which name IDs and layout features survive by default.
import { subset, load, shape, points, glyphFor, readSfnt, setVars } from '../lib/hb.mjs';
import { head, hhea, os2, names, fvar, tables } from '../lib/sfnt.mjs';

const LATIN = [];
for (let c = 0x20; c <= 0x7e; c++) LATIN.push(c);
for (let c = 0xa0; c <= 0xff; c++) LATIN.push(c);
const KERN_TEXT = 'AVATAR Tyrannosaurus WAVY Yo, fly. To "quote" 1/2 ff fi ffl office Ærø façade';

const fmt = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

function diffObj(a, b) {
  const d = {};
  for (const k of Object.keys(a)) if (fmt(a[k]) !== fmt(b[k])) d[k] = [a[k], b[k]];
  return d;
}

/** Max point deviation and advance deviation between two fonts at the given coordinates. */
function compareOutlines(orig, sub, cps, coords) {
  setVars(orig.font, coords);
  setVars(sub.font, coords);
  let maxPt = 0,
    maxAdv = 0,
    worst = null,
    ptCountMismatch = 0;
  for (const cp of cps) {
    const g0 = glyphFor(orig.font, cp),
      g1 = glyphFor(sub.font, cp);
    if (g0 < 0 || g1 < 0) continue;
    const p0 = points(orig.font, g0),
      p1 = points(sub.font, g1);
    if (p0.length !== p1.length) {
      ptCountMismatch++;
      continue;
    }
    for (let i = 0; i < p0.length; i++) {
      const dd = Math.max(Math.abs(p0[i][0] - p1[i][0]), Math.abs(p0[i][1] - p1[i][1]));
      if (dd > maxPt) {
        maxPt = dd;
        worst = { cp: cp.toString(16), i, a: p0[i], b: p1[i] };
      }
    }
    maxAdv = Math.max(maxAdv, Math.abs(orig.font.glyphHAdvance(g0) - sub.font.glyphHAdvance(g1)));
  }
  // Shaping positions of a kerning/ligature string.
  const s0 = shape(orig.font, KERN_TEXT),
    s1 = shape(sub.font, KERN_TEXT);
  let maxPos = 0;
  const sameLen = s0.length === s1.length;
  if (sameLen)
    for (let i = 0; i < s0.length; i++)
      maxPos = Math.max(
        maxPos,
        Math.abs(s0[i].ax - s1[i].ax),
        Math.abs(s0[i].dx - s1[i].dx),
        Math.abs(s0[i].dy - s1[i].dy),
      );
  const e0 = orig.font.hExtents(),
    e1 = sub.font.hExtents();
  return {
    maxPt,
    maxAdv,
    maxPos,
    glyphCountSame: sameLen,
    ptCountMismatch,
    extents: fmt(e0) === fmt(e1) ? 'same' : { orig: e0, sub: e1 },
    worst,
  };
}

function featureTags(face) {
  return {
    GSUB: [...new Set(face.getTableFeatureTags('GSUB'))].sort().join(' '),
    GPOS: [...new Set(face.getTableFeatureTags('GPOS'))].sort().join(' '),
  };
}

async function runVariable(path) {
  const src = await readSfnt(path);
  const orig = load(src);
  console.log(`\n### ${path.split('/').pop()}  axes ${fmt(fvar(src).axes)}  (${src.length} B)`);

  const configs = {
    'latin, all axes': { unicodes: LATIN },
    'latin, wght 400..700': { unicodes: LATIN, axes: { wght: { min: 400, max: 700 } } },
    'latin, wght 400..700, opsz 14..24': {
      unicodes: LATIN,
      axes: { wght: { min: 400, max: 700 }, opsz: { min: 14, max: 24 } },
    },
    'latin, pin wght 400 opsz 16': { unicodes: LATIN, axes: { wght: 400, opsz: 16 } },
    'latin, pin wght 550 opsz 20 (non-default)': { unicodes: LATIN, axes: { wght: 550, opsz: 20 } },
  };
  const samples = {
    'latin, all axes': [
      { wght: 100, opsz: 14 },
      { wght: 400, opsz: 16 },
      { wght: 900, opsz: 32 },
      { wght: 550, opsz: 20 },
    ],
    'latin, wght 400..700': [
      { wght: 400, opsz: 14 },
      { wght: 450, opsz: 20 },
      { wght: 550, opsz: 32 },
      { wght: 700, opsz: 24 },
    ],
    'latin, wght 400..700, opsz 14..24': [
      { wght: 400, opsz: 14 },
      { wght: 450, opsz: 17.5 },
      { wght: 550, opsz: 20 },
      { wght: 700, opsz: 24 },
    ],
    'latin, pin wght 400 opsz 16': [{ wght: 400, opsz: 16 }],
    'latin, pin wght 550 opsz 20 (non-default)': [{ wght: 550, opsz: 20 }],
  };

  const origMetrics = { head: head(src), hhea: hhea(src), os2: os2(src) };
  const origNames = [...new Set(names(src).map((n) => n.id))].sort((a, b) => a - b);
  console.log('orig name IDs:', origNames.join(','), ' features:', fmt(featureTags(orig.face)));

  for (const [label, opts] of Object.entries(configs)) {
    const out = await subset(src, opts);
    const sub = load(out);
    const fv = fvar(out);
    console.log(
      `\n-- ${label}: ${out.length} B, fvar ${fv ? fmt(fv.axes) : 'none'}, tables ${Object.keys(tables(out)).join(' ')}`,
    );
    for (const c of samples[label]) console.log('   at', fmt(c), fmt(compareOutlines(orig, sub, LATIN, c)));
    const m = { head: head(out), hhea: hhea(out), os2: os2(out) };
    for (const t of ['head', 'hhea', 'os2']) console.log(`   ${t} changed:`, fmt(diffObj(origMetrics[t], m[t])));
    console.log(
      '   name IDs:',
      [...new Set(names(out).map((n) => n.id))].sort((a, b) => a - b).join(','),
      ' features:',
      fmt(featureTags(sub.face)),
    );
  }

  // Name IDs / features with the "keep" options.
  const keepAll = await subset(src, { unicodes: LATIN, nameIds: '*', nameLangs: '*', features: '*' });
  console.log(
    '\n-- nameIds:* nameLangs:* features:*',
    keepAll.length,
    'B  name IDs:',
    [...new Set(names(keepAll).map((n) => n.id))].sort((a, b) => a - b).join(','),
    fmt(featureTags(load(keepAll).face)),
  );

  // Determinism within a process.
  const a = await subset(src, configs['latin, wght 400..700']),
    b = await subset(src, configs['latin, wght 400..700']);
  console.log('   repeat subset byte-identical:', Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0);
}

async function runHinted(path) {
  const src = await readSfnt(path);
  console.log(
    `\n### ${path.split('/').pop()} (static, hinted) ${src.length} B tables ${Object.keys(tables(src)).join(' ')}`,
  );
  const orig = load(src);
  for (const [label, opts] of Object.entries({
    'latin, hinting kept': { unicodes: LATIN },
    'latin, no hinting': { unicodes: LATIN, hinting: false },
  })) {
    const out = await subset(src, opts);
    const t = tables(out);
    const hintBytes = ['fpgm', 'prep', 'cvt ', 'hdmx', 'VDMX', 'LTSH']
      .map((k) => `${k.trim()}:${t[k]?.length ?? '-'}`)
      .join(' ');
    console.log(`-- ${label}: ${out.length} B  ${hintBytes}  glyf:${t.glyf.length}`);
    console.log('   outlines', fmt(compareOutlines(orig, load(out), LATIN, {})));
    for (const [k, f] of Object.entries({ head, hhea, os2 }))
      console.log(`   ${k} changed:`, fmt(diffObj(f(src), f(out))));
  }
}

await runVariable(new URL('../fonts/InterVariable.ttf', import.meta.url).pathname);
await runHinted(new URL('../fonts/DejaVuSans.ttf', import.meta.url).pathname);
await runHinted(new URL('../fonts/Inter-Regular-hinted.woff2', import.meta.url).pathname);
