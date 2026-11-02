// Minimal sfnt (TrueType/OpenType) reader and canonical writer.
// The writer is deterministic: tables sorted by tag, 4-byte padded with zeros,
// checksums and head.checkSumAdjustment recomputed.

export interface Sfnt {
  /** sfntVersion: 0x00010000 (TrueType), 'OTTO' (CFF), 'true'. */
  flavor: number;
  tables: Map<string, Uint8Array>;
}

export const TAG = (s: string): number =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
export const untag = (n: number): string =>
  String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

export const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function readSfnt(buf: Uint8Array): Sfnt {
  const dv = view(buf);
  if (buf.byteLength < 12) throw new Error('Not an sfnt font: too short');
  const flavor = dv.getUint32(0);
  const numTables = dv.getUint16(4);
  if (12 + numTables * 16 > buf.byteLength) throw new Error('Not an sfnt font: truncated table directory');
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = untag(dv.getUint32(o));
    const offset = dv.getUint32(o + 8);
    const length = dv.getUint32(o + 12);
    if (offset + length > buf.byteLength) throw new Error(`Table '${tag}' extends past the end of the file`);
    tables.set(tag, buf.subarray(offset, offset + length));
  }
  return { flavor, tables };
}

export function tableTags(buf: Uint8Array): string[] {
  return [...readSfnt(buf).tables.keys()].sort();
}

export function getTable(buf: Uint8Array, tag: string): Uint8Array | undefined {
  return readSfnt(buf).tables.get(tag);
}

export function checksum(data: Uint8Array): number {
  let sum = 0;
  const n = data.byteLength;
  const full = n & ~3;
  const dv = view(data);
  for (let i = 0; i < full; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  if (full < n) {
    let last = 0;
    for (let i = full; i < full + 4; i++) last = (last << 8) | (i < n ? data[i]! : 0);
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

export function writeSfnt(font: Sfnt): Uint8Array {
  const tags = [...font.tables.keys()].sort((a, b) => TAG(a) - TAG(b));
  const n = tags.length;
  let size = 12 + 16 * n;
  for (const t of tags) size += (font.tables.get(t)!.byteLength + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = view(out);

  const entrySelector = n > 0 ? Math.floor(Math.log2(n)) : 0;
  const searchRange = 16 * 2 ** entrySelector;
  dv.setUint32(0, font.flavor);
  dv.setUint16(4, n);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, n * 16 - searchRange);

  let offset = 12 + 16 * n;
  let headOffset = -1;
  tags.forEach((tag, i) => {
    let data = font.tables.get(tag)!;
    if (tag === 'head') {
      data = data.slice();
      if (data.byteLength >= 12) view(data).setUint32(8, 0); // checkSumAdjustment = 0 while summing
      headOffset = offset;
    }
    out.set(data, offset);
    const rec = 12 + i * 16;
    dv.setUint32(rec, TAG(tag));
    dv.setUint32(rec + 4, checksum(data));
    dv.setUint32(rec + 8, offset);
    dv.setUint32(rec + 12, data.byteLength);
    offset += (data.byteLength + 3) & ~3;
  });
  if (headOffset >= 0) dv.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** Replace some tables and re-serialize canonically. */
export function withTables(buf: Uint8Array, patch: Record<string, Uint8Array | null>): Uint8Array {
  const font = readSfnt(buf);
  const tables = new Map(font.tables);
  for (const [tag, data] of Object.entries(patch)) {
    if (data === null) tables.delete(tag);
    else tables.set(tag, data);
  }
  return writeSfnt({ flavor: font.flavor, tables });
}
