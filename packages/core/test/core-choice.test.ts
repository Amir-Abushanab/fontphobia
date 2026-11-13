// `coreThreshold: 'auto'` (§8.2): which used characters join core, on made-up sizes. The planner
// tests run it on real fonts.
import { describe, expect, it } from 'vitest';
import { chooseCore, type CoreSizes } from '../src/index.ts';

/** A 40 KB core and a 100 KB extended file; each character weighs `per` bytes wherever it is. */
const sizes =
  (per = 300) =>
  (add: Set<number>): CoreSizes => ({ core: 40_000 + per * add.size, ext: 100_000 - per * add.size });
const pages = (...groups: [count: number, chars: number[]][]) =>
  groups.flatMap(([count, chars]) => Array.from({ length: count }, () => chars));
const sorted = (s: Set<number>) => [...s].toSorted((a, b) => a - b);

describe("coreThreshold: 'auto'", () => {
  it('adds a character one page uses when the extended file would cost that page more', () => {
    const r = chooseCore(pages([3, []], [1, [0xe9]]), sizes());
    expect(sorted(r.add)).toEqual([0xe9]);
    expect(r.measured).toBe(2);
  });

  it('measures nothing when no page needs more than the fixed core', () => {
    let calls = 0;
    const r = chooseCore(pages([5, []]), (add) => {
      calls++;
      return sizes()(add);
    });
    expect(r).toEqual({ add: new Set(), measured: 0 });
    expect(calls).toBe(0);
  });

  it('leaves a character out when the other pages would pay more for it than its page saves', () => {
    // 401 pages × 300 B is more than the one extended file it would spare.
    expect(sorted(chooseCore(pages([400, []], [1, [0xe9]]), sizes()).add)).toEqual([]);
    // Across 300 pages it is less.
    expect(sorted(chooseCore(pages([300, []], [1, [0xe9]]), sizes()).add)).toEqual([0xe9]);
  });

  it('takes the group that frees the most pages per character first', () => {
    // Characters 1 and 2 free ten pages; character 3 frees one and is not worth 411 × 300 B. Taken in
    // the other order, 3 would have come along with 1 and 2.
    const r = chooseCore(pages([400, []], [10, [1, 2]], [1, [3]]), sizes());
    expect(sorted(r.add)).toEqual([1, 2]);
  });

  it('counts a page as freed only when all of its characters are in core', () => {
    // Page B needs 1 and 2. Adding 1 frees page A alone; B is freed with the step that adds 2.
    const seen: number[][] = [];
    const r = chooseCore(pages([2, []], [1, [1]], [1, [1, 2]]), (add) => {
      seen.push(sorted(add));
      return sizes()(add);
    });
    expect(seen).toEqual([[], [1], [1, 2]]);
    expect(sorted(r.add)).toEqual([1, 2]);
  });

  it('does not depend on the order of the pages', () => {
    const a = pages([40, []], [3, [7, 8]], [2, [8, 9]], [1, [5]]);
    const b = a.toReversed();
    expect(sorted(chooseCore(b, sizes()).add)).toEqual(sorted(chooseCore(a, sizes()).add));
  });

  it('samples a long chain and still finds its cheapest candidate', () => {
    // Character i is the only extra of 101 − i pages: each step frees fewer pages than the one before.
    const groups: [number, number[]][] = Array.from({ length: 100 }, (_, i) => [100 - i, [i + 1]]);
    const all = pages(...groups);
    const cost = (k: number) => {
      const s = sizes()(new Set(Array.from({ length: k }, (_, i) => i + 1)));
      const freed = groups.slice(0, k).reduce((n, [count]) => n + count, 0);
      return all.length * s.core + (all.length - freed) * s.ext;
    };
    const costs = Array.from({ length: 101 }, (_, k) => cost(k));
    const cheapest = costs.indexOf(Math.min(...costs));
    const r = chooseCore(all, sizes());
    expect(cheapest).toBeGreaterThan(16);
    expect(r.add.size).toBe(cheapest);
    expect(sorted(r.add)).toEqual(Array.from({ length: cheapest }, (_, i) => i + 1));
    expect(r.measured).toBeLessThan(40);
  });

  it('is never worse than adding nothing or adding everything', () => {
    // A small fixed generator, so the cases are the same on every run.
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const all = Array.from({ length: 1 + rand(60) }, () =>
        rand(3) ? [] : Array.from({ length: 1 + rand(4) }, () => 1 + rand(12)),
      );
      const per = 100 + rand(4000);
      const used = new Set(all.flat());
      const price = (add: Set<number>) => {
        const s = sizes(per)(add);
        const missing = all.filter((p) => p.some((c) => !add.has(c))).length;
        return all.length * s.core + missing * s.ext;
      };
      const r = chooseCore(all, sizes(per));
      expect(price(r.add)).toBeLessThanOrEqual(Math.min(price(new Set()), price(used)));
      for (const c of r.add) expect(used.has(c)).toBe(true);
    }
  });
});
