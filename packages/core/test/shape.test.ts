import { beforeAll, describe, expect, test } from 'vitest';
import { checkShaping, rangesFromCodePoints, subsetFont, type OutputFile } from '../src/index.ts';
import { ASCII, LATIN1, fixture, range } from './helpers.ts';

const inter = fixture('InterVariable.ttf');
const MARKS = range(0x300, 0x36f);
const EXT = [...range(0xa0, 0x17f), ...MARKS, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026];
const file = async (unicodes: number[], axes?: Record<string, { min: number; max: number }>): Promise<OutputFile> => {
  const r = await subsetFont(inter, { unicodes, axes });
  return { sfnt: r.decoded, ranges: rangesFromCodePoints(r.unicodes) };
};

let whole: OutputFile[], split: OutputFile[], splitMarks: OutputFile[];
beforeAll(async () => {
  whole = [await file([...ASCII, ...EXT])];
  split = [await file(ASCII), await file(EXT)];
  splitMarks = [await file([...ASCII, ...MARKS]), await file(EXT.filter((c) => !MARKS.includes(c)))];
});
const verdict = (files: OutputFile[], text: string, extra: object = {}) => checkShaping(inter, files, [{ text, ...extra }])[0]!.verdict;

describe('checkShaping (reproduces spike 2 in HarfBuzz)', () => {
  test('one file: identical, including variations and features', () => {
    expect(verdict(whole, 'Tö Vä Yö “Too” café')).toEqual({ kind: 'identical' });
    expect(verdict(whole, 'Hamburgefonstiv', { variations: { wght: 650, opsz: 24 } })).toEqual({ kind: 'identical' });
    expect(verdict(whole, '0123', { features: ['tnum'] }).kind).toBe('regression'); // tnum was not kept
  });

  test('kerning across files is a regression', () => {
    expect(verdict(split, 'AVATAR To')).toEqual({ kind: 'identical' });
    expect(verdict(split, 'Tö').kind).toBe('regression');
  });

  test('contextual alternates across files are a regression even when widths match', () => {
    const v = verdict(split, 'Ä:Ö');
    expect(v.kind).toBe('regression');
    expect(v.kind === 'regression' && v.reason).toMatch(/different glyph/);
  });

  test('a mark in another file: Chrome composes to NFC; marks in core is identical', () => {
    expect(verdict(split, 'café').kind).toBe('regression'); // é from ext loses f|é kerning
    expect(verdict(splitMarks, 'café naïve')).toEqual({ kind: 'identical' });
  });

  test('a character no file covers is a regression naming it', () => {
    const v = verdict(split, 'Ж');
    expect(v.kind === 'regression' && v.reason).toMatch(/U\+0416/);
  });

  test('limit-axes: rounding, never identical, within tolerance (spike 3)', async () => {
    const ranged = [await file(LATIN1, { wght: { min: 400, max: 700 } })];
    const v = verdict(ranged, 'The quick brown fox jumps over the lazy dog.', { variations: { wght: 550, opsz: 24 } });
    expect(v.kind).toBe('rounding');
    expect(verdict(ranged, 'The quick brown fox', { variations: { wght: 400, opsz: 14 } })).toEqual({ kind: 'identical' });
  });
});
