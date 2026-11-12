// Locale characters for the safety net (§8.1), from CLDR 49 exemplar sets (scripts/cldr.mjs).
import data from '../data/cldr-exemplars.json' with { type: 'json' };

const d = data as { cldr: string; parents: Record<string, string>; sets: string[]; exemplars: Record<string, number> };

const parse = (r: string): number[] =>
  r.split(',').flatMap((x) => {
    const [a, b] = x.split('-').map((h) => parseInt(h, 16)) as [number, number?];
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });

/** First CLDR id in `has` for a BCP 47 tag, walking parents: "pt-BR" → "pt", "en-AU" → "en-001". A script that differs from the language's default is tried first: "zh-TW" → "zh-Hant", "sr-ME" → "sr-Latn". */
export function cldrFallback(tag: string, has: (id: string) => boolean): string | undefined {
  let t: string;
  let loc: Intl.Locale | undefined;
  try {
    loc = new Intl.Locale(tag);
    t = loc.toString();
  } catch {
    t = tag;
  }
  const walk = (start: string | undefined) => {
    for (let x = start; x;) {
      if (has(x)) return x;
      x = d.parents[x] ?? (x.includes('-') ? x.slice(0, x.lastIndexOf('-')) : undefined);
      if (x === 'root') return undefined;
    }
    return undefined;
  };
  if (loc && !loc.script) {
    try {
      const script = loc.maximize().script;
      if (script && script !== new Intl.Locale(loc.language).maximize().script) {
        const hit =
          walk(loc.region ? `${loc.language}-${script}-${loc.region}` : undefined) ?? walk(`${loc.language}-${script}`);
        if (hit) return hit;
      }
    } catch {
      /* fall through to the plain chain */
    }
  }
  return walk(t);
}

/** CLDR's locale id for a BCP 47 tag with exemplar data. */
export const cldrLocale = (tag: string): string | undefined => cldrFallback(tag, (id) => id in d.exemplars);

/** Characters a locale's text may use, or undefined for a locale CLDR doesn't know. */
export function localeChars(tag: string): number[] | undefined {
  const loc = cldrLocale(tag);
  return loc === undefined ? undefined : parse(d.sets[d.exemplars[loc]!]!);
}

export const CLDR_VERSION = d.cldr;
