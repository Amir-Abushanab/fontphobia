// Parsers for the tables fontphobia reads directly. Shaping, cmap and layout
// queries go through HarfBuzz (see hb.ts).
import { readSfnt, view } from './sfnt.ts';

const need = (buf: Uint8Array, tag: string): DataView => {
  const t = readSfnt(buf).tables.get(tag);
  if (!t) throw new Error(`Font has no '${tag}' table`);
  return view(t);
};
const opt = (buf: Uint8Array, tag: string): Uint8Array | undefined => readSfnt(buf).tables.get(tag);

export interface Head {
  unitsPerEm: number;
  created: bigint;
  modified: bigint;
  bbox: [number, number, number, number];
  macStyle: number;
  indexToLocFormat: number;
}
export function parseHead(buf: Uint8Array): Head {
  const d = need(buf, 'head');
  return {
    unitsPerEm: d.getUint16(18),
    created: d.getBigUint64(20),
    modified: d.getBigUint64(28),
    bbox: [d.getInt16(36), d.getInt16(38), d.getInt16(40), d.getInt16(42)],
    macStyle: d.getUint16(44),
    indexToLocFormat: d.getInt16(50),
  };
}

export interface Hhea {
  ascender: number;
  descender: number;
  lineGap: number;
  numberOfHMetrics: number;
}
export function parseHhea(buf: Uint8Array): Hhea {
  const d = need(buf, 'hhea');
  return {
    ascender: d.getInt16(4),
    descender: d.getInt16(6),
    lineGap: d.getInt16(8),
    numberOfHMetrics: d.getUint16(34),
  };
}

export interface FsType {
  raw: number;
  /** Bits 1–3: 0 = installable, 2 = restricted, 4 = preview & print, 8 = editable. */
  embedding: 'installable' | 'restricted' | 'preview-print' | 'editable' | 'invalid';
  noSubsetting: boolean;
  bitmapOnly: boolean;
}
export interface Os2 {
  version: number;
  xAvgCharWidth: number;
  usWeightClass: number;
  usWidthClass: number;
  fsType: FsType;
  fsSelection: number;
  useTypoMetrics: boolean;
  sTypoAscender: number;
  sTypoDescender: number;
  sTypoLineGap: number;
  usWinAscent: number;
  usWinDescent: number;
  sxHeight?: number;
  sCapHeight?: number;
}
export function decodeFsType(raw: number): FsType {
  const usage = raw & 0x000f;
  const embedding =
    usage === 0
      ? 'installable'
      : usage & 0x2
        ? 'restricted' // restricted wins if several bits are set
        : usage & 0x8
          ? 'editable'
          : usage & 0x4
            ? 'preview-print'
            : 'invalid';
  return { raw, embedding, noSubsetting: (raw & 0x0100) !== 0, bitmapOnly: (raw & 0x0200) !== 0 };
}
export function parseOs2(buf: Uint8Array): Os2 | undefined {
  const t = opt(buf, 'OS/2');
  if (!t) return undefined;
  const d = view(t);
  const version = d.getUint16(0);
  const fsSelection = d.getUint16(62);
  const r: Os2 = {
    version,
    xAvgCharWidth: d.getInt16(2),
    usWeightClass: d.getUint16(4),
    usWidthClass: d.getUint16(6),
    fsType: decodeFsType(d.getUint16(8)),
    fsSelection,
    useTypoMetrics: (fsSelection & 0x80) !== 0,
    sTypoAscender: d.getInt16(68),
    sTypoDescender: d.getInt16(70),
    sTypoLineGap: d.getInt16(72),
    usWinAscent: d.getUint16(74),
    usWinDescent: d.getUint16(76),
  };
  if (version >= 2 && t.byteLength >= 90) {
    r.sxHeight = d.getInt16(86);
    r.sCapHeight = d.getInt16(88);
  }
  return r;
}
/** Returns a copy of the OS/2 table with xAvgCharWidth set. */
export function setXAvgCharWidth(os2: Uint8Array, value: number): Uint8Array {
  const out = os2.slice();
  view(out).setInt16(2, value);
  return out;
}
/** Returns a copy of the head table with created/modified set. */
export function setHeadDates(head: Uint8Array, created: bigint, modified: bigint): Uint8Array {
  const out = head.slice();
  const d = view(out);
  d.setBigUint64(20, created);
  d.setBigUint64(28, modified);
  return out;
}

export function numGlyphs(buf: Uint8Array): number {
  return need(buf, 'maxp').getUint16(4);
}

export interface NameRecord {
  platformID: number;
  encodingID: number;
  languageID: number;
  nameID: number;
  value: string;
}
export function parseName(buf: Uint8Array): NameRecord[] {
  const t = opt(buf, 'name');
  if (!t) return [];
  const d = view(t);
  const count = d.getUint16(2);
  const strOff = d.getUint16(4);
  const out: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    const platformID = d.getUint16(o),
      encodingID = d.getUint16(o + 2),
      languageID = d.getUint16(o + 4),
      nameID = d.getUint16(o + 6);
    const len = d.getUint16(o + 8),
      off = d.getUint16(o + 10);
    const raw = t.subarray(strOff + off, strOff + off + len);
    let value = '';
    if (platformID === 0 || platformID === 3) {
      for (let j = 0; j + 1 < raw.length; j += 2) value += String.fromCharCode((raw[j]! << 8) | raw[j + 1]!);
    } else {
      value = String.fromCharCode(...raw);
    }
    out.push({ platformID, encodingID, languageID, nameID, value });
  }
  return out;
}
/** Best English (Windows 0x409, else Mac Roman 0, else first) string per name ID. */
export function nameStrings(buf: Uint8Array): Map<number, string> {
  const score = (r: NameRecord) =>
    r.platformID === 3 && r.languageID === 0x409
      ? 3
      : r.platformID === 1 && r.languageID === 0
        ? 2
        : r.platformID === 0
          ? 1
          : 0;
  const best = new Map<number, NameRecord>();
  for (const r of parseName(buf)) {
    const cur = best.get(r.nameID);
    if (!cur || score(r) > score(cur)) best.set(r.nameID, r);
  }
  return new Map([...best].toSorted((a, b) => a[0] - b[0]).map(([id, r]) => [id, r.value]));
}

export interface Axis {
  tag: string;
  min: number;
  default: number;
  max: number;
  nameID: number;
  hidden: boolean;
}
export interface Fvar {
  axes: Axis[];
  instanceCount: number;
}
export function parseFvar(buf: Uint8Array): Fvar | undefined {
  const t = opt(buf, 'fvar');
  if (!t) return undefined;
  const d = view(t);
  const axesOff = d.getUint16(4),
    axisCount = d.getUint16(8),
    axisSize = d.getUint16(10),
    instanceCount = d.getUint16(12);
  const fx = (o: number) => d.getInt32(o) / 65536;
  const axes: Axis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const o = axesOff + i * axisSize;
    axes.push({
      tag: String.fromCharCode(...t.subarray(o, o + 4)),
      min: fx(o + 4),
      default: fx(o + 8),
      max: fx(o + 12),
      hidden: (d.getUint16(o + 16) & 1) === 1,
      nameID: d.getUint16(o + 18),
    });
  }
  return { axes, instanceCount };
}

export interface Gasp {
  version: number;
  ranges: { maxPPEM: number; behavior: number }[];
}
export function parseGasp(buf: Uint8Array): Gasp | undefined {
  const t = opt(buf, 'gasp');
  if (!t) return undefined;
  const d = view(t);
  const n = d.getUint16(2);
  return {
    version: d.getUint16(0),
    ranges: Array.from({ length: n }, (_, i) => ({
      maxPPEM: d.getUint16(4 + i * 4),
      behavior: d.getUint16(6 + i * 4),
    })),
  };
}

/** Total bytes of TrueType glyph instructions in glyf (0 for CFF fonts). */
export function glyfInstructionBytes(buf: Uint8Array): number {
  const { tables } = readSfnt(buf);
  const glyf = tables.get('glyf'),
    loca = tables.get('loca'),
    head = tables.get('head');
  if (!glyf || !loca || !head) return 0;
  const long = view(head).getInt16(50) === 1;
  const lv = view(loca),
    gv = view(glyf);
  const n = long ? loca.byteLength / 4 - 1 : loca.byteLength / 2 - 1;
  const at = (i: number) => (long ? lv.getUint32(i * 4) : lv.getUint16(i * 2) * 2);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const start = at(i),
      end = at(i + 1);
    if (end - start < 10) continue;
    const contours = gv.getInt16(start);
    if (contours >= 0) {
      const p = start + 10 + contours * 2;
      if (p + 2 <= end) total += gv.getUint16(p);
    } else {
      // Composite glyph: walk components; instructions follow if WE_HAVE_INSTRUCTIONS was set.
      let p = start + 10;
      let flags = 0;
      let haveInstr = false;
      do {
        flags = gv.getUint16(p);
        p += 4 + (flags & 0x0001 ? 4 : 2);
        if (flags & 0x0008) p += 2;
        else if (flags & 0x0040) p += 4;
        else if (flags & 0x0080) p += 8;
        if (flags & 0x0100) haveInstr = true;
      } while (flags & 0x0020 && p < end);
      if (haveInstr && p + 2 <= end) total += gv.getUint16(p);
    }
  }
  return total;
}
