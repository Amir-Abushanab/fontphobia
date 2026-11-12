// unicode-range parsing and canonical formatting (sorted, merged, uppercase hex).

export type Range = [number, number];

/** Parse a CSS unicode-range value or a CLI list: "U+20-7E, U+A0, U+4??". */
export function parseUnicodeRange(value: string): Range[] {
  const out: Range[] = [];
  for (const raw of value.split(',')) {
    const part = raw.trim().replace(/^u\+/i, '');
    if (!part) continue;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^([0-9a-f]{1,6})-([0-9a-f]{1,6})$/i))) out.push([parseInt(m[1]!, 16), parseInt(m[2]!, 16)]);
    else if ((m = part.match(/^([0-9a-f]{0,5})(\?{1,6})$/i)) && m[1]!.length + m[2]!.length <= 6) {
      const base = parseInt((m[1] || '0') + '0'.repeat(m[2]!.length), 16);
      out.push([base, base + 16 ** m[2]!.length - 1]);
    } else if ((m = part.match(/^([0-9a-f]{1,6})$/i))) {
      const v = parseInt(m[1]!, 16);
      out.push([v, v]);
    } else throw new Error(`Bad unicode-range part ${JSON.stringify(raw.trim())}`);
  }
  for (const [a, b] of out)
    if (a > b || b > 0x10ffff) throw new Error(`Bad unicode-range U+${a.toString(16)}-${b.toString(16)}`);
  return mergeRanges(out);
}

export function mergeRanges(ranges: Range[]): Range[] {
  const s = [...ranges].toSorted((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Range[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function rangesFromCodePoints(cps: Iterable<number>): Range[] {
  return mergeRanges([...cps].map((c) => [c, c] as Range));
}

export function* codePointsOf(ranges: Range[]): Generator<number> {
  for (const [a, b] of ranges) for (let c = a; c <= b; c++) yield c;
}

export function inRanges(ranges: Range[], cp: number): boolean {
  let lo = 0,
    hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

const hex = (n: number) => n.toString(16).toUpperCase();
export function formatUnicodeRange(ranges: Range[]): string {
  return mergeRanges(ranges)
    .map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`))
    .join(', ');
}
