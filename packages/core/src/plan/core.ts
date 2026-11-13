// Which of the characters a site uses go in the core file (§8.2, `coreThreshold: 'auto'`).
//
// Every page that draws a face loads its core file. A page also loads the extended file as soon as
// one of its characters is there, and that file holds the whole safety net too. So where a rarely
// used character costs less depends on sizes, not on how many pages use it: in core it adds its own
// bytes to every page, in extended it adds the whole extended file to each page that uses it.
//
// The choice is therefore measured. Pages are grouped by the characters they need beyond core's
// fixed part. The groups join core one at a time, the one that frees the most pages per character
// first, which gives a chain of candidate cores from "nothing added" to "everything used". Each
// candidate is priced as what all the face's pages download together: core on every page, extended
// on each page still missing a character. The cheapest candidate wins; between equals, the smaller
// core.
//
// Pure and deterministic. The caller supplies the sizes (subsets as HarfBuzz writes them, before
// WOFF2: compressing is some hundred times slower and shrinks both files by about the same ratio).

export interface CoreSizes {
  /** Bytes of the core file once the characters are added. */
  core: number;
  /** Bytes of the extended file that is left; 0 when nothing is left. */
  ext: number;
}

export interface CoreChoice {
  /** The characters to add to core's fixed part. */
  add: Set<number>;
  /** How many candidate cores were measured. */
  measured: number;
}

/** Candidates measured per pass. A longer chain is sampled evenly, then searched again around the best sample. */
const PER_PASS = 16;

interface Group {
  key: string;
  chars: number[];
  /** Pages that need exactly these characters. */
  pages: number;
  /** Characters not in core yet. */
  left: number;
}

/**
 * `pages`: for each page that draws the face, the kept characters it needs that core's fixed part
 * lacks (none: the page already loads core alone). `measure`: the two file sizes with a set added.
 */
export function chooseCore(pages: Iterable<Iterable<number>>, measure: (add: Set<number>) => CoreSizes): CoreChoice {
  const byKey = new Map<string, Group>();
  let total = 0;
  let free = 0;
  for (const page of pages) {
    total++;
    const chars = [...new Set(page)].toSorted((a, b) => a - b);
    if (!chars.length) {
      free++;
      continue;
    }
    const key = chars.join(' ');
    const group = byKey.get(key);
    if (group) group.pages++;
    else byKey.set(key, { key, chars, pages: 1, left: chars.length });
  }
  if (!byKey.size) return { add: new Set(), measured: 0 };
  // Sorted, so the result doesn't depend on the order the pages came in.
  const groups = [...byKey.values()].toSorted((a, b) => (a.key < b.key ? -1 : 1));
  const using = new Map<number, Group[]>();
  for (const g of groups) for (const c of g.chars) (using.get(c) ?? using.set(c, []).get(c)!).push(g);

  // The chain. steps[i] holds what joins core at step i and how many pages load core alone after it.
  const steps: { chars: number[]; free: number }[] = [];
  const added = new Set<number>();
  const freeAtStart = free;
  for (;;) {
    let next: Group | undefined;
    for (const g of groups) {
      if (!g.left) continue;
      if (!next) {
        next = g;
        continue;
      }
      // Pages per character, compared as cross products; between equals, the smaller step.
      const [mine, theirs] = [g.pages * next.left, next.pages * g.left];
      if (mine > theirs || (mine === theirs && g.left < next.left)) next = g;
    }
    if (!next) break;
    const chars = next.chars.filter((c) => !added.has(c));
    for (const c of chars) {
      added.add(c);
      for (const g of using.get(c)!) if (--g.left === 0) free += g.pages;
    }
    steps.push({ chars, free });
  }

  // cost(i): what the pages download with the first i steps in core.
  const costs = new Map<number, number>();
  const upTo = (i: number) => new Set(steps.slice(0, i).flatMap((s) => s.chars));
  const cost = (i: number) => {
    let v = costs.get(i);
    if (v === undefined) {
      const sizes = measure(upTo(i));
      v = total * sizes.core + (total - (i ? steps[i - 1]!.free : freeAtStart)) * sizes.ext;
      costs.set(i, v);
    }
    return v;
  };
  let lo = 0;
  let hi = steps.length;
  for (;;) {
    const span = hi - lo;
    const all = span < PER_PASS;
    const points = Array.from({ length: all ? span + 1 : PER_PASS }, (_, j) =>
      all ? lo + j : lo + Math.floor((j * span) / (PER_PASS - 1)),
    );
    let at = 0;
    let least = cost(points[0]!);
    for (let j = 1; j < points.length; j++) {
      const v = cost(points[j]!);
      if (v < least) [at, least] = [j, v];
    }
    if (all) return { add: upTo(points[at]!), measured: costs.size };
    lo = points[Math.max(0, at - 1)]!;
    hi = points[Math.min(points.length - 1, at + 1)]!;
  }
}
