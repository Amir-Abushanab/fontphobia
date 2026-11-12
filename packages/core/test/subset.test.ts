import { describe, expect, test } from 'vitest';
import {
  loadFont,
  nameStrings,
  parseFvar,
  parseHead,
  parseHhea,
  parseOs2,
  readSfnt,
  subsetFont,
  toSfnt,
  ValidationError,
} from '../src/index.ts';
import { ASCII, LATIN1, fixture, sha256 } from './helpers.ts';

const inter = fixture('InterVariable.ttf');
const dejavu = fixture('DejaVuSans.ttf');
const features = (sfnt: Uint8Array) => {
  const { face } = loadFont(sfnt);
  return new Set([...face.getTableFeatureTags('GSUB'), ...face.getTableFeatureTags('GPOS')]);
};

describe('subsetFont', () => {
  test('cmap is exactly the requested set ∩ the source cmap', async () => {
    const r = await subsetFont(inter, { unicodes: [...LATIN1, 0x10ffff] });
    const cmap = new Set(loadFont(inter).face.collectUnicodes());
    expect(cmap.has(0xad)).toBe(false); // Inter has no soft hyphen
    expect(r.unicodes).toEqual(LATIN1.filter((c) => cmap.has(c)));
    expect(String.fromCharCode(...r.woff2.subarray(0, 4))).toBe('wOF2');
  });

  test('one half of a bidi-mirrored pair is accepted, and the output lists its mirror', async () => {
    for (const [text, mirrored] of [
      ['a>b', [0x3c, 0x3e]],
      ['(hello', [0x28, 0x29]],
    ] as const) {
      const r = await subsetFont(inter, { unicodes: [...text].map((c) => c.codePointAt(0)!) });
      for (const c of mirrored) expect(r.unicodes).toContain(c);
      expect(r.unicodes).toEqual([...loadFont(r.decoded).face.collectUnicodes()].toSorted((x, y) => x - y));
    }
  });

  test('vertical metrics, unitsPerEm, fsType, head dates and xAvgCharWidth are preserved', async () => {
    for (const src of [inter, dejavu, await toSfnt(fixture('Inter-Regular-hinted.woff2'))]) {
      const { decoded } = await subsetFont(src, { unicodes: ASCII });
      expect(parseHhea(decoded)).toMatchObject({
        ascender: parseHhea(src).ascender,
        descender: parseHhea(src).descender,
        lineGap: parseHhea(src).lineGap,
      });
      const a = parseOs2(src)!,
        b = parseOs2(decoded)!;
      for (const k of [
        'sTypoAscender',
        'sTypoDescender',
        'sTypoLineGap',
        'usWinAscent',
        'usWinDescent',
        'xAvgCharWidth',
        'useTypoMetrics',
      ] as const)
        expect(b[k], k).toBe(a[k]);
      expect(b.fsType).toEqual(a.fsType);
      const ha = parseHead(src),
        hb = parseHead(decoded);
      expect([hb.unitsPerEm, hb.created, hb.modified]).toEqual([ha.unitsPerEm, ha.created, ha.modified]);
    }
  });

  test('default features: HarfBuzz defaults, which drop features CSS must enable (spike 3)', async () => {
    const f = features((await subsetFont(inter, { unicodes: LATIN1 })).decoded);
    expect(f.has('kern')).toBe(true);
    expect(f.has('calt')).toBe(true);
    expect(f.has('tnum')).toBe(false);
    expect(f.has('ss01')).toBe(false);
  });

  test('features.add keeps the defaults plus the added tags', async () => {
    const f = features((await subsetFont(inter, { unicodes: LATIN1, features: { add: ['tnum', 'ss01'] } })).decoded);
    for (const t of ['kern', 'calt', 'tnum', 'ss01']) expect(f.has(t), t).toBe(true);
    expect(f.has('ss02')).toBe(false);
  });

  test('features.only keeps exactly those', async () => {
    const f = features((await subsetFont(inter, { unicodes: LATIN1, features: { only: ['kern'] } })).decoded);
    expect([...f]).toEqual(['kern']);
  });

  test('license name IDs 13 and 14 are kept by default (HarfBuzz drops them)', async () => {
    const n = nameStrings((await subsetFont(inter, { unicodes: ASCII })).decoded);
    const src = nameStrings(inter);
    for (const id of [0, 1, 2, 3, 4, 5, 6, 13, 14]) if (src.has(id)) expect(n.get(id), `name ${id}`).toBe(src.get(id));
    expect(n.has(7)).toBe(false); // trademark: not in the default list
    // fvar/STAT references survive
    for (const a of parseFvar(inter)!.axes) expect(n.has(a.nameID), `axis name ${a.nameID}`).toBe(true);
  });

  test('hinting is kept by default and dropped on request', async () => {
    const kept = readSfnt((await subsetFont(dejavu, { unicodes: ASCII })).decoded).tables;
    const dropped = readSfnt((await subsetFont(dejavu, { unicodes: ASCII, hinting: false })).decoded).tables;
    for (const t of ['fpgm', 'prep', 'cvt ']) {
      expect(kept.has(t), t).toBe(true);
      expect(dropped.has(t), t).toBe(false);
    }
  });

  test('axes: kept whole by default; ranges keep fvar; pins drop it', async () => {
    expect(
      parseFvar((await subsetFont(inter, { unicodes: ASCII })).decoded)!.axes.map((a) => [a.tag, a.min, a.max]),
    ).toEqual([
      ['opsz', 14, 32],
      ['wght', 100, 900],
    ]);
    const ranged = parseFvar(
      (await subsetFont(inter, { unicodes: ASCII, axes: { wght: { min: 400, max: 700 } } })).decoded,
    )!;
    expect(ranged.axes.find((a) => a.tag === 'wght')).toMatchObject({ min: 400, max: 700 });
    const pinned = await subsetFont(inter, { unicodes: ASCII, axes: { wght: 400, opsz: 14 } });
    expect(parseFvar(pinned.decoded)).toBeUndefined();
  });

  test('DSIG is always dropped', async () => {
    const withDsig = (await import('../src/index.ts')).withTables(dejavu, {
      DSIG: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]),
    });
    expect(readSfnt((await subsetFont(withDsig, { unicodes: ASCII })).decoded).tables.has('DSIG')).toBe(false);
  });

  test('deterministic: repeated runs give identical bytes', async () => {
    const o = { unicodes: LATIN1, features: { add: ['tnum'] } };
    const a = await subsetFont(inter, o),
      b = await subsetFont(inter, o);
    expect(sha256(a.woff2)).toBe(sha256(b.woff2));
  });

  test('bad input fails loudly', async () => {
    await expect(subsetFont(inter, { unicodes: ASCII, axes: { wdth: 100 } })).rejects.toThrow(/axis 'wdth'/);
    await expect(subsetFont(inter, { unicodes: ASCII, features: { only: ['toolong'] } })).rejects.toThrow(
      /Bad feature tag/,
    );
    void ValidationError;
  });
});
