import { deflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import {
  compressedSize,
  detectFormat,
  readSfnt,
  toSfnt,
  woff2Compress,
  woff2Decompress,
  hbSubset,
  view,
} from '../src/index.ts';
import { ASCII, fixture, range } from './helpers.ts';

test('detects containers', () => {
  expect(detectFormat(fixture('DejaVuSans.ttf'))).toBe('truetype');
  expect(detectFormat(fixture('Inter-Regular-hinted.woff2'))).toBe('woff2');
  expect(() => detectFormat(new Uint8Array([1, 2, 3, 4]))).toThrow(/unknown signature/);
});

test('concurrent WOFF2 calls are serialized and return valid, independent results (spike 4)', async () => {
  const src = fixture('InterVariable.ttf');
  const inputs = [[0x41], [0x42, 0x43], [0x44, 0x45, 0x46]].map((u) => hbSubset(src, { unicodes: u }));
  const sequential: Uint8Array[] = [];
  for (const i of inputs) sequential.push(await woff2Compress(i));
  const parallel = await Promise.all(inputs.map((i) => woff2Compress(i)));
  for (let i = 0; i < inputs.length; i++) {
    expect(String.fromCharCode(...parallel[i]!.subarray(0, 4))).toBe('wOF2');
    expect(parallel[i]).toEqual(sequential[i]);
  }
  const decoded = await Promise.all(parallel.map((p) => woff2Decompress(p)));
  for (const d of decoded) expect(readSfnt(d).tables.has('glyf')).toBe(true);
});

test('compressedSize follows the WOFF2 size where the uncompressed size does not', async () => {
  // A small core beside a large extended file, then the reverse: the two ends of the core choice.
  const src = fixture('InterVariable.ttf');
  const more = [...range(0xa0, 0x24f), ...range(0x370, 0x3ff), ...range(0x400, 0x4ff)];
  const subsets = [ASCII, more, [...ASCII, ...more.slice(0, 700)], more.slice(700)].map((u) =>
    hbSubset(src, { unicodes: u }),
  );
  const spread = async (size: (b: Uint8Array) => number) => {
    const ratios: number[] = [];
    for (const s of subsets) ratios.push(size(s) / (await woff2Compress(s)).byteLength);
    return Math.max(...ratios) / Math.min(...ratios);
  };
  expect(await spread(compressedSize)).toBeLessThan(1.03);
  expect(await spread((b) => b.byteLength)).toBeGreaterThan(1.2);
  // Node's own Brotli: the same sizes on every Node version, or plans would differ between machines.
  expect(subsets.slice(0, 2).map(compressedSize)).toEqual([48996, 153854]);
});

/** Minimal WOFF 1.0 encoder, only for testing the decoder. */
function encodeWoff1(sfnt: Uint8Array): Uint8Array {
  const { flavor, tables } = readSfnt(sfnt);
  const tags = [...tables.keys()].toSorted();
  const entries = tags.map((tag) => {
    const orig = tables.get(tag)!;
    const z = new Uint8Array(deflateSync(orig));
    return { tag, orig, data: z.byteLength < orig.byteLength ? z : orig };
  });
  let size = 44 + 20 * entries.length;
  for (const e of entries) size += (e.data.byteLength + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = view(out);
  out.set([0x77, 0x4f, 0x46, 0x46]);
  dv.setUint32(4, flavor);
  dv.setUint32(8, size);
  dv.setUint16(12, entries.length);
  let off = 44 + 20 * entries.length;
  entries.forEach((e, i) => {
    const r = 44 + i * 20;
    out.set(
      [...e.tag].map((c) => c.charCodeAt(0)),
      r,
    );
    dv.setUint32(r + 4, off);
    dv.setUint32(r + 8, e.data.byteLength);
    dv.setUint32(r + 12, e.orig.byteLength);
    out.set(e.data, off);
    off += (e.data.byteLength + 3) & ~3;
  });
  return out;
}

test('decodes WOFF 1.0', async () => {
  const sfnt = hbSubset(fixture('DejaVuSans.ttf'), { unicodes: ASCII });
  const decoded = await toSfnt(encodeWoff1(sfnt));
  const a = readSfnt(sfnt).tables,
    b = readSfnt(decoded).tables;
  for (const [tag, data] of a) if (tag !== 'head') expect(b.get(tag), tag).toEqual(data);
});
