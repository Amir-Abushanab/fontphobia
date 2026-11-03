// FreeType's auto-hinter (Linux and ChromeOS: Chrome with hinting on, Firefox and WebKitGTK at their
// default "slight") measures each font's blue zones and stem widths from reference characters it
// looks up in the cmap: "THEZOCQS" for Latin capitals, "o" for stems, and so on. A file without them
// hints its glyphs differently from the source font, so the same "é" renders differently from the
// extended file. Each non-core file therefore carries the references for its scripts in its cmap,
// outside its unicode-range, so browsers never draw them from it (M5 notes). From FreeType's
// src/autofit/afblue.dat and afscript.h.
const LATIN = 'THEZOCQS' + 'HEZLOCUS' + 'fijkdbh' + 'uvxzoesc' + 'nrxzoesc' + 'pqgjy' + 'oO0';
const GREEK = 'ΓΒΕΖΘΟΩ' + 'ΒΔΖΞΘΟ' + 'βθδζλξ' + 'αειοπστω' + 'βγημρφχψ' + 'οΟ';
const CYRILLIC = 'БВЕПЗОСЭ' + 'БВЕШЗОСЭ' + 'хпншезос' + 'руф' + 'оО';
const HEBREW = 'בדהחךכםס' + 'בטכםסצ' + 'קךןףץ' + 'ם';
const ARMENIAN = 'ԱՄՒՍԲԳԴՕ' + 'ՒՈԴՃՇՍՏՕ' + 'եէիմվֆճ' + 'այւսգշրօ' + 'հոճաեւսօ' + 'բըիլղպփւ' + 'օՕ';
const GEORGIAN = 'გდელოჰ' + 'აზმსშძ' + 'ბვთკჩწ' + 'იოუძღჭ' + 'ო';

const cps = (s: string) => [...new Set([...s].map((c) => c.codePointAt(0)!))];
const SCRIPTS: { test: RegExp; refs: number[] }[] = [
  { test: /\p{Script=Greek}/u, refs: cps(GREEK) },
  { test: /\p{Script=Cyrillic}/u, refs: cps(CYRILLIC) },
  { test: /\p{Script=Hebrew}/u, refs: cps(HEBREW) },
  { test: /\p{Script=Armenian}/u, refs: cps(ARMENIAN) },
  { test: /\p{Script=Georgian}/u, refs: cps(GEORGIAN) },
];
const LATIN_REFS = cps(LATIN);

/**
 * Reference characters (in the font, not in `set`) the auto-hinter needs to hint `set`'s glyphs as it
 * does in the full font. Latin always: it is the auto-hinter's fallback for punctuation and symbols.
 */
export function hintRefs(set: Iterable<number>, cmap: Set<number>): number[] {
  const have = new Set(set);
  const out = new Set<number>(LATIN_REFS);
  for (const s of SCRIPTS) if ([...have].some((c) => s.test.test(String.fromCodePoint(c)))) for (const r of s.refs) out.add(r);
  return [...out].filter((c) => cmap.has(c) && !have.has(c)).sort((a, b) => a - b);
}

/** Glyph → every source code point that maps to it. */
export function reverseCmap(font: { nominalGlyph(cp: number): number | undefined }, cmap: Iterable<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const cp of cmap) { const g = font.nominalGlyph(cp); if (g !== undefined) (out.get(g) ?? out.set(g, []).get(g)!).push(cp); }
  return out;
}

/**
 * Code points (not in `set`) that share a glyph with one in `set` in the source cmap. The auto-hinter
 * also decides a glyph's treatment from every code point that maps to it: Inter's ’ glyph is also
 * ʼ (U+02BC), a "non-base" modifier letter, which turns off its blue-zone snapping. A file that maps
 * the glyph from U+2019 alone hints it differently (M5 notes).
 */
export function cmapAliases(set: Iterable<number>, font: { nominalGlyph(cp: number): number | undefined }, byGlyph: Map<number, number[]>): number[] {
  const have = new Set(set);
  const out = new Set<number>();
  for (const cp of have) { const g = font.nominalGlyph(cp); for (const a of g !== undefined ? byGlyph.get(g) ?? [] : []) if (!have.has(a)) out.add(a); }
  return [...out].sort((a, b) => a - b);
}
