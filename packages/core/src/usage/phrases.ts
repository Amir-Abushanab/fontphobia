// Context across a word break, for the shaping check (PLAN §8.3).
//
// The planner shapes each recorded word split across the files and whole, and moves a word's
// characters into core when the two differ. A word is not always enough: a font can pick a glyph
// from what stands on the other side of a space. Inter's contextual alternates draw a raised "±"
// between digits or capitals ("1 ± 2"), and the plain one elsewhere. When "±" comes from the
// extended file and the digits from core, the browser shapes "±" alone and draws the plain one.
//
// Such rules are about a symbol and what surrounds it, so a word made of symbols only is also
// recorded with the word on each side of it.

// Printable ASCII and the punctuation that is always in core (the planner's CORE_BASE): a phrase of
// these alone can't be split between files.
const ALWAYS_CORE = /^[\x20-\x7e\u00a0\u2010\u2013\u2014\u2018\u2019\u201c\u201d\u2026]*$/;
const symbolsOnly = (word: string) => word !== '' && !/[\p{L}\p{N}\p{M}]/u.test(word);

/**
 * `word` with the words next to it in the same run of text, when `word` is symbols only and one of
 * the three has a character that can land outside core. `prev`/`next`: undefined when there is none,
 * or when another font draws it.
 */
export function phraseAround(prev: string | undefined, word: string, next: string | undefined): string | undefined {
  if (!symbolsOnly(word) || (prev === undefined && next === undefined)) return undefined;
  const phrase = [prev, word, next].filter((w) => w !== undefined).join(' ');
  return ALWAYS_CORE.test(phrase) ? undefined : phrase;
}
