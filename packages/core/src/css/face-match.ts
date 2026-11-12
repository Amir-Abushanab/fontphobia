// Which @font-face rule a face came from, when the URL alone can't say: providers serve one variable
// file for every weight (Google: `wght@300;400;700` gives three rules with one URL).
import { codePointsOf, formatUnicodeRange, parseUnicodeRange, rangesFromCodePoints } from './unicode-range.ts';
import { parseWeightDescriptor } from './values.ts';

const norm = (v: string | undefined, d: string) => (v ?? d).trim().replace(/\s+/g, ' ').toLowerCase();
/** `U+??` and `U+0-FF` are the same range. */
const range = (v: string | undefined) =>
  v ? formatUnicodeRange(rangesFromCodePoints([...codePointsOf(parseUnicodeRange(v))])) : '';

/** Do two @font-face descriptor sets select the same face (weight, style, stretch, unicode-range)? */
export function sameFaceDescriptors(a: Record<string, string>, b: Record<string, string>): boolean {
  return (
    parseWeightDescriptor(a['font-weight']).join() === parseWeightDescriptor(b['font-weight']).join() &&
    norm(a['font-style'], 'normal') === norm(b['font-style'], 'normal') &&
    norm(a['font-stretch'], '100%') === norm(b['font-stretch'], '100%') &&
    range(a['unicode-range']) === range(b['unicode-range'])
  );
}
