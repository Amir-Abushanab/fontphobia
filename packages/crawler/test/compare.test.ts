// The pixel gate (§10.3): every differing pixel counts, including the gray pixels on a glyph's edge,
// and a difference is reported when every load repeats it.
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { diffPixels, repeatedPixels, type Shots } from '../src/verify.ts';

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

/** A white image with some pixels (by index, `y * width + x`) at a gray level. */
const image = (levels: Record<number, number> = {}, width = W, height = H): PNG => {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (const [p, v] of Object.entries(levels)) png.data.fill(v, Number(p) * 4, Number(p) * 4 + 3);
  return png;
};
const shots = (before: Record<number, number>, after: Record<number, number>): Shots => ({
  before: image(before),
  after: image(after),
});
/** Serves the given loads in order, then the last one again. */
const loads = (...all: Shots[]) => {
  let i = 0;
  return () => Promise.resolve(all[Math.min(i++, all.length - 1)]!);
};

describe('repeatedPixels', () => {
  it('keeps a difference once three reloads in a row draw both sides as the first load did', async () => {
    const changed = shots({}, { 5: 100, 17: 254 });
    const r = await repeatedPixels(changed, loads(changed));
    expect([...r.pixels]).toEqual([5, 17]);
    expect(r).toMatchObject({ differed: 2, reloads: 3, identical: false, width: W });
  });

  it('drops a pixel that either side draws differently on a reload', async () => {
    // The original drew it another way this once.
    const one = await repeatedPixels(shots({ 5: 254 }, {}), loads(shots({}, {})));
    expect(one).toMatchObject({ differed: 1, reloads: 1, identical: true });
    expect(one.pixels).toHaveLength(0);
    // Each load has its own stray pixels: no load matches another, and nothing repeats.
    const each = await repeatedPixels(shots({ 1: 254 }, { 2: 254 }), loads(shots({ 3: 254 }, { 4: 254 })));
    expect(each).toMatchObject({ differed: 2, reloads: 1, identical: false });
    expect(each.pixels).toHaveLength(0);
    // Content that changes by itself: a new value on every load.
    const moving = await repeatedPixels(shots({ 9: 10 }, { 9: 20 }), loads(shots({ 9: 30 }, { 9: 40 })));
    expect(moving.pixels).toHaveLength(0);
  });

  it('keeps a small change under larger noise, and only the change', async () => {
    const noise = (from: number) => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [from + i, 254]));
    // One pixel of the new files is wrong on every load; 30 other pixels of the original change per load.
    // No reload matches the first, so they run out.
    const r = await repeatedPixels(
      shots(noise(0), { 100: 0 }),
      loads(...Array.from({ length: 12 }, (_, i) => shots(noise(30 + i), { 100: 0 }))),
    );
    expect([...r.pixels]).toEqual([100]);
    expect(r).toMatchObject({ differed: 31, reloads: 12 });
  });

  it('does not take a stray pixel that repeats a few times for a change', async () => {
    const stray = shots({}, { 5: 254 });
    // The stray pixel comes out the same twice while another part of the page changes, then it is gone.
    const r = await repeatedPixels(
      stray,
      loads(shots({ 50: 254 }, { 5: 254 }), shots({ 51: 254 }, { 5: 254 }), shots({}, {})),
    );
    expect(r.pixels).toHaveLength(0);
    expect(r).toMatchObject({ reloads: 3, identical: true });
  });

  it('starts counting again after a reload that differs from the first', async () => {
    const changed = shots({}, { 5: 254 });
    const r = await repeatedPixels(changed, loads(changed, changed, shots({ 60: 254 }, { 5: 254 }), changed));
    expect([...r.pixels]).toEqual([5]);
    expect(r.reloads).toBe(6);
  });

  it('compares the area both screenshots cover, and drops a pixel a reload does not cover', async () => {
    const first = { before: image({ 100: 0 }), after: image({}, W, H - 2) };
    const kept = await repeatedPixels(first, loads(first));
    expect([...kept.pixels]).toEqual([100]);
    // 100 is on row 8; this reload of the original is 5 rows tall.
    const short = await repeatedPixels(first, loads({ before: image({}, W, 5), after: first.after }));
    expect(short.pixels).toHaveLength(0);
  });
});
