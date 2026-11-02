// Minimal sfnt table directory reader (no deps).
import { readFileSync } from 'node:fs';
export function tables(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(...buf.subarray(o, o + 4));
    out[tag] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
  }
  return out;
}
export function table(buf, tag) {
  const t = tables(buf)[tag];
  return t ? buf.subarray(t.offset, t.offset + t.length) : null;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) {
    const t = tables(readFileSync(f));
    console.log(f.split('/').pop(), Object.entries(t).map(([k, v]) => `${k}:${v.length}`).join(' '));
  }
}

const dvOf = (t) => new DataView(t.buffer, t.byteOffset, t.byteLength);
export function head(buf) {
  const d = dvOf(table(buf, 'head'));
  return { unitsPerEm: d.getUint16(18), created: d.getBigUint64(20), modified: d.getBigUint64(28), xMin: d.getInt16(36), yMin: d.getInt16(38), xMax: d.getInt16(40), yMax: d.getInt16(42), macStyle: d.getUint16(44), lowestRecPPEM: d.getUint16(46), indexToLocFormat: d.getInt16(50), checkSumAdjustment: d.getUint32(8), flags: d.getUint16(16) };
}
export function hhea(buf) {
  const d = dvOf(table(buf, 'hhea'));
  return { ascender: d.getInt16(4), descender: d.getInt16(6), lineGap: d.getInt16(8), advanceWidthMax: d.getUint16(10), minLSB: d.getInt16(12), minRSB: d.getInt16(14), xMaxExtent: d.getInt16(16), caretSlopeRise: d.getInt16(18), caretSlopeRun: d.getInt16(20), numberOfHMetrics: d.getUint16(34) };
}
export function os2(buf) {
  const d = dvOf(table(buf, 'OS/2'));
  const v = d.getUint16(0);
  const r = { version: v, xAvgCharWidth: d.getInt16(2), usWeightClass: d.getUint16(4), usWidthClass: d.getUint16(6), fsType: d.getUint16(8), ulUnicodeRange: [d.getUint32(42), d.getUint32(46), d.getUint32(50), d.getUint32(54)].map((x) => x.toString(16)).join(','), fsSelection: d.getUint16(62), usFirstCharIndex: d.getUint16(64), usLastCharIndex: d.getUint16(66), sTypoAscender: d.getInt16(68), sTypoDescender: d.getInt16(70), sTypoLineGap: d.getInt16(72), usWinAscent: d.getUint16(74), usWinDescent: d.getUint16(76) };
  if (v >= 1) r.ulCodePageRange = [d.getUint32(78), d.getUint32(82)].map((x) => x.toString(16)).join(',');
  if (v >= 2) Object.assign(r, { sxHeight: d.getInt16(86), sCapHeight: d.getInt16(88), usDefaultChar: d.getUint16(90), usBreakChar: d.getUint16(92), usMaxContext: d.getUint16(94) });
  return r;
}
export function names(buf) {
  const t = table(buf, 'name'); if (!t) return [];
  const d = dvOf(t);
  const count = d.getUint16(2), strOff = d.getUint16(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    const [plat, enc, lang, id, len, off] = [0, 2, 4, 6, 8, 10].map((k) => d.getUint16(o + k));
    const raw = t.subarray(strOff + off, strOff + off + len);
    let s = '';
    if (plat === 3 || plat === 0) for (let j = 0; j + 1 < raw.length; j += 2) s += String.fromCharCode((raw[j] << 8) | raw[j + 1]);
    else s = String.fromCharCode(...raw);
    out.push({ plat, enc, lang, id, s });
  }
  return out;
}
export function fvar(buf) {
  const t = table(buf, 'fvar'); if (!t) return null;
  const d = dvOf(t);
  const axesOff = d.getUint16(4), axisCount = d.getUint16(8), axisSize = d.getUint16(10), instCount = d.getUint16(12);
  const fx = (o) => d.getInt32(o) / 65536;
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const o = axesOff + i * axisSize;
    axes.push({ tag: String.fromCharCode(...t.subarray(o, o + 4)), min: fx(o + 4), def: fx(o + 8), max: fx(o + 12) });
  }
  return { axes, instCount };
}
