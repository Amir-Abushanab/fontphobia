// The PostScript names inside a CFF (version 1) table, for OFL Reserved Font Name renames (§11).
// A CFF font carries its family in the CFF table as well as in name: the Name INDEX holds the
// PostScript FontName, the Top DICT's FullName and FamilyName point into the String INDEX, and a
// CID-keyed font names each Font DICT. Layout follows Adobe Technical Note #5176.
//
// The table is rebuilt as header + Name INDEX + Top DICT INDEX + String INDEX, then everything that
// followed the String INDEX copied unchanged. Only absolute offsets need fixing after that: the
// Top DICT's, which are rewritten as 5-byte integers so its size is known before the shift is, and
// the Private offsets of the Font DICTs in a CID-keyed font's FDArray, which are patched in place.
// Notice, Copyright and version are left byte-identical, as the name table's license records are.

/** Custom strings start at this SID; lower SIDs are the standard strings. */
const STD_STRINGS = 391;

const OP = {
  version: 0,
  Notice: 1,
  FullName: 2,
  FamilyName: 3,
  charset: 15,
  Encoding: 16,
  CharStrings: 17,
  Private: 18,
  Copyright: (12 << 8) | 0,
  FDArray: (12 << 8) | 36,
  FDSelect: (12 << 8) | 37,
  FontName: (12 << 8) | 38,
} as const;

interface Operand {
  /** Where the operand's bytes start in the table. */
  at: number;
  bytes: Uint8Array;
  /** Integer value; NaN for a real number. */
  value: number;
}
interface Entry {
  op: number;
  operands: Operand[];
}

interface Index {
  items: Uint8Array[];
  /** Where the INDEX ends in the table. */
  end: number;
}

function readIndex(t: Uint8Array, at: number, what: string): Index {
  if (at + 2 > t.length) throw new Error(`CFF ${what} INDEX runs past the end of the table`);
  const count = (t[at]! << 8) | t[at + 1]!;
  if (count === 0) return { items: [], end: at + 2 };
  const offSize = t[at + 2]!;
  if (offSize < 1 || offSize > 4) throw new Error(`CFF ${what} INDEX has offSize ${offSize}`);
  if (at + 3 + (count + 1) * offSize > t.length) throw new Error(`CFF ${what} INDEX runs past the end of the table`);
  const offAt = (i: number) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + t[at + 3 + i * offSize + k]!;
    return v;
  };
  // Offsets are 1-based from the byte before the data.
  const base = at + 3 + (count + 1) * offSize - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const a = offAt(i),
      b = offAt(i + 1);
    if (a < 1 || b < a || base + b > t.length) throw new Error(`CFF ${what} INDEX has a bad offset`);
    items.push(t.subarray(base + a, base + b));
  }
  return { items, end: base + offAt(count) };
}

function writeIndex(items: Uint8Array[]): Uint8Array {
  if (!items.length) return new Uint8Array(2);
  const data = items.reduce((n, x) => n + x.length, 0);
  const offSize = data + 1 < 1 << 8 ? 1 : data + 1 < 1 << 16 ? 2 : data + 1 < 1 << 24 ? 3 : 4;
  const out = new Uint8Array(3 + (items.length + 1) * offSize + data);
  out[0] = items.length >> 8;
  out[1] = items.length & 255;
  out[2] = offSize;
  let off = 1,
    pos = 3 + (items.length + 1) * offSize;
  const put = (i: number, v: number) => {
    for (let k = offSize - 1; k >= 0; k--, v = Math.floor(v / 256)) out[3 + i * offSize + k] = v & 255;
  };
  items.forEach((x, i) => {
    put(i, off);
    out.set(x, pos);
    pos += x.length;
    off += x.length;
  });
  put(items.length, off);
  return out;
}

/** A DICT's operator/operand pairs, in order, with each operand's original bytes. */
function readDict(t: Uint8Array, start: number, end: number): Entry[] {
  const entries: Entry[] = [];
  let operands: Operand[] = [];
  let i = start;
  while (i < end) {
    const b0 = t[i]!;
    const at = i;
    let value: number;
    if (b0 <= 21) {
      let op = b0;
      if (b0 === 12) op = (12 << 8) | t[++i]!;
      i++;
      entries.push({ op, operands });
      operands = [];
      continue;
    } else if (b0 === 28) {
      value = ((t[i + 1]! << 24) | (t[i + 2]! << 16)) >> 16;
      i += 3;
    } else if (b0 === 29) {
      value = (t[i + 1]! << 24) | (t[i + 2]! << 16) | (t[i + 3]! << 8) | t[i + 4]!;
      i += 5;
    } else if (b0 === 30) {
      // Real number: nibbles until one is 0xf.
      for (i++; i < end; i++) if ((t[i]! & 0xf) === 0xf || t[i]! >> 4 === 0xf) break;
      i++;
      value = NaN;
    } else if (b0 >= 32 && b0 <= 246) {
      value = b0 - 139;
      i += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      value = (b0 - 247) * 256 + t[i + 1]! + 108;
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      value = -(b0 - 251) * 256 - t[i + 1]! - 108;
      i += 2;
    } else throw new Error(`CFF DICT has a reserved byte ${b0}`);
    if (i > end) throw new Error('CFF DICT operand runs past the end of the DICT');
    operands.push({ at, bytes: t.subarray(at, i), value });
  }
  if (operands.length) throw new Error('CFF DICT ends with operands but no operator');
  return entries;
}

const int32 = (v: number) => Uint8Array.of(29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const opBytes = (op: number) => (op > 255 ? Uint8Array.of(12, op & 255) : Uint8Array.of(op));

/** `v` encoded in exactly `width` bytes, the width of an operand it replaces; undefined if it doesn't fit. */
function intOfWidth(v: number, width: number): Uint8Array | undefined {
  if (!Number.isInteger(v)) return undefined;
  if (width === 5) return int32(v);
  if (width === 3 && v >= -32768 && v <= 32767) return Uint8Array.of(28, (v >> 8) & 255, v & 255);
  if (width === 2 && v >= 108 && v <= 1131) return Uint8Array.of(((v - 108) >> 8) + 247, (v - 108) & 255);
  if (width === 2 && v <= -108 && v >= -1131) return Uint8Array.of(((-v - 108) >> 8) + 251, (-v - 108) & 255);
  if (width === 1 && v >= -107 && v <= 107) return Uint8Array.of(v + 139);
  return undefined;
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Parsed {
  header: Uint8Array;
  names: Index;
  top: Entry[];
  topEnd: number;
  strings: Index;
}

function parse(cff: Uint8Array): Parsed {
  if (cff.length < 4) throw new Error('CFF table is too short');
  if (cff[0] !== 1) throw new Error(`CFF table version ${cff[0]} isn't supported (only CFF version 1 has names)`);
  const hdrSize = cff[2]!;
  const names = readIndex(cff, hdrSize, 'Name');
  const tops = readIndex(cff, names.end, 'Top DICT');
  if (names.items.length !== 1 || tops.items.length !== 1)
    throw new Error(`CFF table holds ${tops.items.length} fonts; an OpenType font has exactly one`);
  const topStart = tops.items[0]!.byteOffset - cff.byteOffset;
  const top = readDict(cff, topStart, topStart + tops.items[0]!.length);
  const strings = readIndex(cff, tops.end, 'String');
  return { header: cff.subarray(0, hdrSize), names, top, topEnd: tops.end, strings };
}

const sidOf = (dict: Entry[], op: number) => dict.find((e) => e.op === op)?.operands[0]?.value;

/** The Font DICTs of a CID-keyed font's FDArray, read from the table. */
function fontDicts(cff: Uint8Array, top: Entry[]): Entry[][] {
  const at = top.find((e) => e.op === OP.FDArray)?.operands[0]?.value;
  if (at === undefined) return [];
  return readIndex(cff, at, 'FDArray').items.map((d) => {
    const s = d.byteOffset - cff.byteOffset;
    return readDict(cff, s, s + d.length);
  });
}

/** The name-bearing strings of a CFF table: the Name INDEX entry, Top DICT strings and Font DICT FontNames. */
export interface CffNames {
  fontName: string;
  fullName?: string;
  familyName?: string;
  notice?: string;
  copyright?: string;
  version?: string;
  /** FontName of each Font DICT in a CID-keyed font's FDArray (empty for a name-keyed font). */
  fdFontNames: (string | undefined)[];
  cidKeyed: boolean;
}

/** Read the names a CFF table carries (for checks and tests; standard-string SIDs read as undefined). */
export function cffNames(cff: Uint8Array): CffNames {
  const p = parse(cff);
  const str = (sid: number | undefined) =>
    sid !== undefined && sid >= STD_STRINGS && p.strings.items[sid - STD_STRINGS]
      ? latin1(p.strings.items[sid - STD_STRINGS]!)
      : undefined;
  return {
    fontName: latin1(p.names.items[0]!),
    fullName: str(sidOf(p.top, OP.FullName)),
    familyName: str(sidOf(p.top, OP.FamilyName)),
    notice: str(sidOf(p.top, OP.Notice)),
    copyright: str(sidOf(p.top, OP.Copyright)),
    version: str(sidOf(p.top, OP.version)),
    fdFontNames: fontDicts(cff, p.top).map((d) => str(sidOf(d, OP.FontName))),
    cidKeyed: p.top.some((e) => e.op === OP.FDArray),
  };
}

/** Top DICT operators whose operands are offsets from the start of the table (which operand, and the predefined ids that aren't offsets). */
const OFFSET_OPS = new Map<number, { operand: number; predefined: number }>([
  [OP.charset, { operand: 0, predefined: 2 }],
  [OP.Encoding, { operand: 0, predefined: 1 }],
  [OP.CharStrings, { operand: 0, predefined: -1 }],
  [OP.Private, { operand: 1, predefined: -1 }],
  [OP.FDArray, { operand: 0, predefined: -1 }],
  [OP.FDSelect, { operand: 0, predefined: -1 }],
]);

/**
 * The CFF table with `from` replaced by `to` in the FontName (Name INDEX), FullName, FamilyName and
 * a CID-keyed font's Font DICT FontNames. PostScript names drop spaces, as name IDs 6 and 25 do.
 */
export function renameCff(cff: Uint8Array, from: string, to: string): Uint8Array {
  const p = parse(cff);
  const psTo = to.replace(/\s+/g, '');
  const plain = (s: string) => s.replace(new RegExp(escape(from), 'g'), to);
  const ps = (s: string) =>
    s.replace(new RegExp(escape(from), 'g'), psTo).replace(new RegExp(escape(from.replace(/\s+/g, '')), 'g'), psTo);
  // Strings are one byte per character; a PostScript FontName is printable ASCII without spaces.
  const enc = (s: string, fontName = false) => {
    if (fontName ? /[^\x21-\x7e]/.test(s) : [...s].some((c) => c.charCodeAt(0) > 0xff))
      throw new Error(`Can't write ${JSON.stringify(s)} as a CFF ${fontName ? 'FontName' : 'string'}`);
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  const strings = [...p.strings.items];
  const fds = fontDicts(cff, p.top);
  const protectedSids = new Set([OP.Notice, OP.Copyright, OP.version].map((op) => sidOf(p.top, op)));
  const renameSid = (sid: number | undefined, fn: (s: string) => string, what: string) => {
    if (sid === undefined || sid < STD_STRINGS) return; // a standard string is never a family name
    const old = strings[sid - STD_STRINGS];
    if (!old) throw new Error(`CFF ${what} points at a missing string (SID ${sid})`);
    const next = fn(latin1(old));
    if (next === latin1(old)) return;
    // Rewriting a string Notice or Copyright also uses would change the license text.
    if (protectedSids.has(sid)) throw new Error(`CFF ${what} shares its string with Notice, Copyright or version`);
    strings[sid - STD_STRINGS] = enc(next);
  };
  renameSid(sidOf(p.top, OP.FullName), plain, 'FullName');
  renameSid(sidOf(p.top, OP.FamilyName), plain, 'FamilyName');
  fds.forEach((d, i) => renameSid(sidOf(d, OP.FontName), ps, `Font DICT ${i} FontName`));

  // Top DICT: original operand bytes, except offsets, which take 5 bytes whatever their value.
  const oldPrefix = p.strings.end;
  const topParts: (Uint8Array | { offset: number })[] = [];
  for (const e of p.top) {
    const off = OFFSET_OPS.get(e.op);
    e.operands.forEach((o, k) => {
      if (!off || k !== off.operand || o.value <= off.predefined) return void topParts.push(o.bytes);
      if (!(o.value >= oldPrefix && o.value <= cff.length))
        throw new Error(`CFF Top DICT offset ${o.value} doesn't point past the String INDEX`);
      topParts.push({ offset: o.value });
    });
    topParts.push(opBytes(e.op));
  }
  const topLength = topParts.reduce((n, x) => n + ('offset' in x ? 5 : x.length), 0);

  const nameIndex = writeIndex([enc(ps(latin1(p.names.items[0]!)), true)]);
  const stringIndex = writeIndex(strings);
  const topIndexLength = writeIndex([new Uint8Array(topLength)]).length;
  const newPrefix = p.header.length + nameIndex.length + topIndexLength + stringIndex.length;
  const delta = newPrefix - oldPrefix;

  const topDict = new Uint8Array(topLength);
  topParts.reduce((pos, x) => {
    const bytes = 'offset' in x ? int32(x.offset + delta) : x;
    topDict.set(bytes, pos);
    return pos + bytes.length;
  }, 0);

  const tail = cff.slice(oldPrefix);
  // A Font DICT's Private offset is absolute too; it is patched in place at its existing width.
  for (const [i, d] of fds.entries()) {
    const o = d.find((e) => e.op === OP.Private)?.operands[1];
    if (!o) continue;
    if (o.at < oldPrefix) throw new Error(`CFF Font DICT ${i} lies before the end of the String INDEX`);
    const bytes = intOfWidth(o.value + delta, o.bytes.length);
    if (!bytes)
      throw new Error(
        `CFF Font DICT ${i}'s Private offset is a ${o.bytes.length}-byte number and can't hold ${o.value + delta}`,
      );
    tail.set(bytes, o.at - oldPrefix);
  }

  const out = new Uint8Array(newPrefix + tail.length);
  let pos = 0;
  for (const part of [p.header, nameIndex, writeIndex([topDict]), stringIndex, tail]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
