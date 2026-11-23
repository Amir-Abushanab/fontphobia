// Text the crawl can't see (config `extraText`): added by a script after the page has loaded, or
// behind an interaction. The audit never records its characters, so the plan treats them as unused
// and they land in the extended file, which the page then downloads for one late character (found
// on principlestash.com: a weather label's degree sign, 14.7 KB).
//
// Declared per page, the text counts as drawn there, like text the audit saw: its characters join
// the page's and the face's, and its words join the face's for the shaping repair.
import { codePointsOf, formatUnicodeRange, parseUnicodeRange, rangesFromCodePoints } from '../css/unicode-range.ts';
import type { UsageFileJson } from '../plan/planner.ts';
import { globToRegExp, isGlob } from '../project/detect.ts';

/** Page path, glob or `*` → the text, in every face the page draws, or per font family. */
export type ExtraText = Record<string, string | Record<string, string>>;

const add = (range: string | undefined, text: string) =>
  formatUnicodeRange(
    rangesFromCodePoints(
      new Set([
        ...codePointsOf(parseUnicodeRange(range ?? '')),
        ...[...text].map((ch) => ch.codePointAt(0)!).filter((cp) => cp > 0x20 && cp !== 0x7f),
      ]),
    ),
  );
const count = (range: string) => [...codePointsOf(parseUnicodeRange(range))].length;

/**
 * `usage` with the declared text counted (a copy; `usage` is not changed). `unmatched`: patterns no
 * audited page matches, and families no matching page draws.
 */
export function withExtraText(
  usage: UsageFileJson,
  extra: ExtraText | undefined,
): { usage: UsageFileJson; unmatched: string[] } {
  if (!extra || !Object.keys(extra).length) return { usage, unmatched: [] };
  const out = structuredClone(usage);
  const unmatched: string[] = [];
  for (const [pattern, value] of Object.entries(extra)) {
    const matches =
      pattern === '*' ? () => true : isGlob(pattern) ? (p: string) => globToRegExp(pattern).test(p) : null;
    const pages = Object.keys(out.pages).filter((p) => (matches ? matches(p) : p === pattern));
    if (!pages.length) {
      unmatched.push(pattern);
      continue;
    }
    const byFamily = typeof value === 'string' ? undefined : value;
    const seen = new Set<string>();
    for (const page of pages) {
      const faces = out.pages[page]!.faces;
      for (const id of Object.keys(faces)) {
        const face = out.faces[id];
        if (!face) continue;
        const family = Object.keys(byFamily ?? {}).find((f) => f.toLowerCase() === face.family.toLowerCase());
        const text = byFamily ? (family === undefined ? undefined : byFamily[family]) : (value as string);
        if (!text) continue;
        if (family) seen.add(family);
        faces[id] = add(faces[id], text);
        face.chars = add(face.chars, text);
        face.count = count(face.chars);
        const words = face.contexts[0]?.words;
        for (const word of text.split(/\s+/).filter(Boolean)) if (words && !words.includes(word)) words.push(word);
      }
    }
    for (const family of Object.keys(byFamily ?? {})) if (!seen.has(family)) unmatched.push(`${pattern}: ${family}`);
  }
  return { usage: out, unmatched };
}
