// OFL Reserved Font Name renames (§11): rewrite the family in the internal names. Records other
// than the renamed IDs keep their exact bytes; copyright and license (0, 13, 14) are never touched.
import { readSfnt } from './sfnt.ts';

/** IDs that carry the family name (§11). */
export const RENAMED_IDS = new Set([1, 3, 4, 6, 16, 18, 21, 25]);

const enc16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) >> 8;
    b[i * 2 + 1] = s.charCodeAt(i) & 255;
  }
  return b;
};
const dec16 = (b: Uint8Array) => {
  let s = '';
  for (let j = 0; j + 1 < b.length; j += 2) s += String.fromCharCode((b[j]! << 8) | b[j + 1]!);
  return s;
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The name table with `from` replaced by `to` in the family-bearing records. PostScript names (6, 25) drop
 * spaces. A CFF font also names itself in its CFF table, which `renameCff` (cff.ts) rewrites.
 */
export function renameTable(sfnt: Uint8Array, from: string, to: string): Uint8Array {
  const t = readSfnt(sfnt).tables.get('name');
  if (!t) throw new Error('Font has no name table');
  const d = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const format = d.getUint16(0),
    count = d.getUint16(2),
    strOff = d.getUint16(4);
  const recs: { head: number[]; bytes: Uint8Array }[] = [];
  const patterns = [new RegExp(escape(from), 'g'), new RegExp(escape(from.replace(/\s+/g, '')), 'g')];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    const [pid, eid, lid, nid] = [d.getUint16(o), d.getUint16(o + 2), d.getUint16(o + 4), d.getUint16(o + 6)];
    const len = d.getUint16(o + 8),
      off = d.getUint16(o + 10);
    let bytes = t.slice(strOff + off, strOff + off + len);
    if (RENAMED_IDS.has(nid!)) {
      const wide = pid === 0 || pid === 3;
      const value = wide ? dec16(bytes) : String.fromCharCode(...bytes);
      const ps = nid === 6 || nid === 25;
      let next = value.replace(patterns[0]!, ps ? to.replace(/\s+/g, '') : to);
      // The unique ID (3) usually embeds the PostScript name, as in "3.052;ADBO;SourceSans3-Regular;ADOBE".
      if (ps || nid === 3) next = next.replace(patterns[1]!, to.replace(/\s+/g, ''));
      if (next !== value) {
        if (!wide && /[^\x20-\x7e]/.test(next)) continue; // Mac Roman can't hold it: drop the legacy record
        bytes = wide ? enc16(next) : Uint8Array.from(next, (c) => c.charCodeAt(0));
      }
    }
    recs.push({ head: [pid!, eid!, lid!, nid!], bytes });
  }
  // Format 1 language tags follow the records; keep them by staying on format 0 only when there are none.
  if (format !== 0) throw new Error(`name table format ${format} isn't supported for renames`);
  const header = 6 + recs.length * 12;
  const total = header + recs.reduce((n, r) => n + r.bytes.length, 0);
  const out = new Uint8Array(total);
  const w = new DataView(out.buffer);
  w.setUint16(0, 0);
  w.setUint16(2, recs.length);
  w.setUint16(4, header);
  let off = 0;
  recs.forEach((r, i) => {
    const o = 6 + i * 12;
    r.head.forEach((v, k) => w.setUint16(o + k * 2, v));
    w.setUint16(o + 8, r.bytes.length);
    w.setUint16(o + 10, off);
    out.set(r.bytes, header + off);
    off += r.bytes.length;
  });
  return out;
}
