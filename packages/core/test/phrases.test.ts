// Context across a word break (usage/phrases.ts), and the repair it makes possible (§8.3).
import { describe, expect, it } from 'vitest';
import {
  codePointsOf,
  formatUnicodeRange,
  parseUnicodeRange,
  phraseAround,
  planFace,
  rangesFromCodePoints,
  type UsageFaceJson,
  type UsageFileJson,
} from '../src/index.ts';
import { fixture } from './helpers.ts';

describe('phraseAround', () => {
  it('gives a word of symbols with the words next to it', () => {
    expect(phraseAround('1', '±', '2')).toBe('1 ± 2');
    expect(phraseAround('¶', '±', '¿')).toBe('¶ ± ¿');
    // A symbol that is always in core, between words that may not be.
    expect(phraseAround('Α', '+', 'Β')).toBe('Α + Β');
    expect(phraseAround(undefined, '×', '2')).toBe('× 2');
    expect(phraseAround('1', '×', undefined)).toBe('1 ×');
  });

  it('gives nothing for a word with a letter or a digit, or when no part can leave core', () => {
    expect(phraseAround('1', 'é', '2')).toBeUndefined();
    expect(phraseAround('a', '2', 'b')).toBeUndefined();
    expect(phraseAround('1', '+', '2')).toBeUndefined();
    expect(phraseAround('word', '—', 'word')).toBeUndefined();
    expect(phraseAround(undefined, '±', undefined)).toBeUndefined();
  });
});

describe('the shaping repair with a phrase', () => {
  const ranges = (s: string) => formatUnicodeRange(rangesFromCodePoints([...s].map((c) => c.codePointAt(0)!)));
  const plan = async (words: string[]) => {
    const text = 'Hello 1 ± 2';
    const face: UsageFaceJson = {
      family: 'Inter',
      descriptors: { 'font-family': 'Inter', 'font-weight': '100 900' },
      source: { adapter: 'css', fontFile: 'InterVariable.ttf' },
      files: [{ url: '/InterVariable.ttf', bytes: 879708 }],
      chars: ranges(text),
      count: [...text].length,
      inserted: {},
      contexts: [{ features: '', axes: { wght: [400, 400], opsz: [16, 16] }, words }],
      rendered: { weight: [400], axes: { wght: [400], opsz: [16] } },
      declared: {},
      features: [],
      locales: ['en'],
      pages: ['/', '/a', '/b'],
    };
    const usage = {
      version: 1,
      meta: {},
      faces: { inter: face },
      pages: Object.fromEntries(
        [
          ['/', 'Hello'],
          ['/a', 'Hello'],
          ['/b', text],
        ].map(([p, t]) => [p, { faces: { inter: ranges(t!) }, bytes: 0, fonts: [] }]),
      ),
    } as unknown as UsageFileJson;
    // A fixed share: "±", on one page of three, is not chosen for core.
    const p = await planFace(
      'inter',
      face,
      usage,
      { bytes: fixture('InterVariable.ttf'), file: 'InterVariable.ttf' },
      { coreThreshold: 0.9 },
    );
    const core = new Set(codePointsOf(parseUnicodeRange(p.files!.find((f) => f.role === 'core')!.unicodeRange)));
    return { plusMinusInCore: core.has(0xb1), repair: p.repair };
  };

  it('moves "±" into core when the font draws it differently between digits (Inter\'s contextual alternates)', async () => {
    // Word by word, "±" shapes the same alone as next to a space, so it stays in the extended file.
    const alone = await plan(['Hello ', ' 1 ', ' ± ', ' 2']);
    expect(alone.plusMinusInCore).toBe(false);
    expect(alone.repair).toBeUndefined();
    // With its neighbours it is the raised "±" in the whole font and the plain one split.
    const withPhrase = await plan(['Hello ', ' 1 ', ' ± ', ' 2', '1 ± 2']);
    expect(withPhrase.plusMinusInCore).toBe(true);
    expect(withPhrase.repair!.words).toEqual(['1 ± 2']);
  });
});
