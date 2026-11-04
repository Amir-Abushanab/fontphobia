// Locale characters for the safety net (§8.1), from CLDR 49 exemplar sets (scripts/cldr.mjs).
import data from '../data/cldr-exemplars.json' with { type: 'json' };

const d = data as { cldr: string; parents: Record<string, string>; sets: string[]; exemplars: Record<string, number> };

const parse = (r: string): number[] => r.split(',').flatMap((x) => {
  const [a, b] = x.split('-').map((h) => parseInt(h, 16)) as [number, number?];
  return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
});

/** CLDR's locale id for a BCP 47 tag, walking parents: "pt-BR" → "pt", "en-AU" → "en-001". */
export function cldrLocale(tag: string): string | undefined {
  let t: string | undefined;
  try { t = new Intl.Locale(tag).toString(); } catch { t = tag; }
  while (t) {
    if (t in d.exemplars) return t;
    t = d.parents[t] ?? (t.includes('-') ? t.slice(0, t.lastIndexOf('-')) : undefined);
    if (t === 'root') return undefined;
  }
  return undefined;
}

/** Characters a locale's text may use, or undefined for a locale CLDR doesn't know. */
export function localeChars(tag: string): number[] | undefined {
  const loc = cldrLocale(tag);
  return loc === undefined ? undefined : parse(d.sets[d.exemplars[loc]!]!);
}

export const CLDR_VERSION = d.cldr;
