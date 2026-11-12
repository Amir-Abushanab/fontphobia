// CSS font matching (CSS Fonts 4 §5.2) for @font-face faces, and per-character attribution
// through a font-family stack (§7.3 "Character attribution").
import type { Range } from '../css/unicode-range.ts';
import { inRanges } from '../css/unicode-range.ts';
import type { Interval, StyleValue } from '../css/values.ts';

export interface MatchableFace {
  weight: Interval;
  style: StyleValue;
  stretch: Interval;
  unicodeRange: Range[];
}

export interface Wanted { weight: number; style: StyleValue; stretch: number }

type Score = [tier: number, dist: number];
const better = (a: Score, b: Score) => a[0] - b[0] || a[1] - b[1];

function nearest([lo, hi]: Interval, d: number): number { return d < lo ? lo : d > hi ? hi : d; }

function weightScore(i: Interval, d: number): Score {
  const p = nearest(i, d);
  if (p === d) return [0, 0];
  if (d >= 400 && d <= 500) {
    if (p > d && p <= 500) return [1, p - d];
    if (p < d) return [2, d - p];
    return [3, p - d];
  }
  if (d < 400) return p < d ? [1, d - p] : [2, p - d];
  return p > d ? [1, p - d] : [2, d - p];
}

function stretchScore(i: Interval, d: number): Score {
  const p = nearest(i, d);
  if (p === d) return [0, 0];
  if (d <= 100) return p < d ? [1, d - p] : [2, p - d];
  return p > d ? [1, p - d] : [2, d - p];
}

/** Lower is better: italic wants italic > oblique > normal; normal wants normal > oblique > italic. */
function styleScore(f: StyleValue, want: StyleValue): Score {
  if (want.kind === 'italic') return f.kind === 'italic' ? [0, 0] : f.kind === 'oblique' ? [1, Math.abs(14 - nearest([f.min, f.max], 14))] : [2, 0];
  if (want.kind === 'oblique') {
    const a = want.min;
    if (f.kind === 'oblique') return [0, Math.abs(a - nearest([f.min, f.max], a))];
    return f.kind === 'italic' ? [1, 0] : [2, 0];
  }
  if (f.kind === 'normal') return [0, 0];
  if (f.kind === 'oblique') { const p = nearest([f.min, f.max], 0); return p === 0 ? [0, 0] : [1, Math.abs(p)]; }
  return [2, 0];
}

function keepBest<T>(xs: T[], score: (x: T) => Score): T[] {
  let best: Score | null = null;
  let out: T[] = [];
  for (const x of xs) {
    const s = score(x);
    const c = best ? better(s, best) : -1;
    if (c < 0) { best = s; out = [x]; } else if (c === 0) out.push(x);
  }
  return out;
}

/**
 * The faces of one family that match: stretch first, then style, then weight. Returned in the
 * order the browser checks them for a character: reverse definition order (CSS Fonts 4 §4.5).
 */
export function matchFaces<T extends MatchableFace>(familyFaces: T[], want: Wanted): T[] {
  if (!familyFaces.length) return [];
  let c = keepBest(familyFaces, (f) => stretchScore(f.stretch, want.stretch));
  c = keepBest(c, (f) => styleScore(f.style, want.style));
  c = keepBest(c, (f) => weightScore(f.weight, want.weight));
  return [...c].toReversed();
}

/** Parse a computed font-style value ("normal", "italic", "oblique 10deg"). */
export function computedStyle(v: string): StyleValue {
  const s = v.trim().toLowerCase();
  if (s === 'italic') return { kind: 'italic' };
  if (s.startsWith('oblique')) { const a = parseFloat(s.slice(7)); const n = Number.isFinite(a) ? a : 14; return { kind: 'oblique', min: n, max: n }; }
  return { kind: 'normal' };
}

export type Attribution<T> = { face: T } | { system: string };

/**
 * Walk a family stack for one code point. `families` maps a family key to its faces in
 * definition order. A face counts only if its unicode-range and its file's cmap include the
 * character (`covers`). A name with no @font-face is a system font: it stops the walk when
 * `isInstalled` says it's present (default: always).
 */
export function attribute<T extends MatchableFace>(
  stack: string[], cp: number, want: Wanted, families: Map<string, T[]>,
  covers: (face: T, cp: number) => boolean, isInstalled: (family: string) => boolean = () => true,
): Attribution<T> {
  for (const fam of stack) {
    const faces = families.get(fam.toLowerCase());
    if (faces?.length) {
      for (const f of matchFaces(faces, want)) if (inRanges(f.unicodeRange, cp) && covers(f, cp)) return { face: f };
      continue;
    }
    if (isInstalled(fam)) return { system: fam };
  }
  return { system: '(browser default)' };
}
