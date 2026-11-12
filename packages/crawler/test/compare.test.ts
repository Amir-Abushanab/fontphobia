// The pixel gate (§10.3): every differing pixel counts, including the gray pixels on a glyph's edge.
import { describe, expect, it } from 'vitest';
import { diffPixels } from '../src/verify.ts';

const W = 12,
  H = 12;
/** A 3px black stem on white with a 1px gray edge on each side; `edge(y)` is the edge's gray level on row y. */
const stem = (edge: (y: number) => number): Buffer => {
  const d = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = x < 5 ? 255 : x === 5 ? edge(y) : x < 9 ? 0 : x === 9 ? edge(y) : 255;
      const k = (y * W + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
    }
  return d;
};
const red = (png: { data: Buffer }) => {
  let n = 0;
  for (let k = 0; k < png.data.length; k += 4)
    if (png.data[k] === 255 && png.data[k + 1] === 0 && png.data[k + 2] === 0) n++;
  return n;
};

describe('diffPixels', () => {
  it('reports identical images as 0', () => {
    expect(
      diffPixels(
        stem(() => 128),
        stem(() => 128),
        W,
        H,
      ).pixels,
    ).toBe(0);
  });

  it('counts a glyph edge that changed on every row', () => {
    const r = diffPixels(
      stem(() => 128),
      stem(() => 90),
      W,
      H,
    );
    expect(r.pixels).toBe(2 * H);
    expect(red(r.diff)).toBe(2 * H); // drawn in red, which is what maps a difference back to its text node
  });

  it('counts an edge that changed on alternating rows, lighter or darker', () => {
    expect(
      diffPixels(
        stem(() => 128),
        stem((y) => (y % 2 ? 60 : 128)),
        W,
        H,
      ).pixels,
    ).toBe(H);
    expect(
      diffPixels(
        stem(() => 128),
        stem((y) => (y % 2 ? 200 : 128)),
        W,
        H,
      ).pixels,
    ).toBe(H);
  });

  it('counts a single edge pixel pair and a one-level change', () => {
    expect(
      diffPixels(
        stem(() => 128),
        stem((y) => (y === 6 ? 20 : 128)),
        W,
        H,
      ).pixels,
    ).toBe(2);
    expect(
      diffPixels(
        stem(() => 128),
        stem((y) => (y === 6 ? 129 : 128)),
        W,
        H,
      ).pixels,
    ).toBe(2);
  });
});
