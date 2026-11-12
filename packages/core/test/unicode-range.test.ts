import { expect, test } from 'vitest';
import { formatUnicodeRange, inRanges, parseUnicodeRange, rangesFromCodePoints } from '../src/index.ts';

test('parses singles, ranges and wildcards, then merges', () => {
  expect(parseUnicodeRange('U+0025-00FF, u+4??, U+20')).toEqual([
    [0x20, 0x20],
    [0x25, 0xff],
    [0x400, 0x4ff],
  ]);
  expect(parseUnicodeRange('U+20-7E, U+7F, U+80-9F')).toEqual([[0x20, 0x9f]]);
  expect(() => parseUnicodeRange('U+ZZ')).toThrow();
  expect(() => parseUnicodeRange('U+110000')).toThrow();
});

test('formats canonically', () => {
  expect(formatUnicodeRange(rangesFromCodePoints([0x41, 0x20, 0x42, 0x43, 0x2026]))).toBe('U+20, U+41-43, U+2026');
});

test('membership', () => {
  const r = parseUnicodeRange('U+20-7E, U+300-36F');
  expect(inRanges(r, 0x41)).toBe(true);
  expect(inRanges(r, 0x301)).toBe(true);
  expect(inRanges(r, 0xe9)).toBe(false);
});
