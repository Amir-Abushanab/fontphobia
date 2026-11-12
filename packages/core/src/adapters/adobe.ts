// `adobe-fonts` (§6.6): report only. Adobe's license forbids modifying or self-hosting kit fonts, so
// fontphobia never writes them anywhere; the audit inspects the files it already downloaded, in
// memory, and turns what it measures into steps for the kit settings on fonts.adobe.com.
import { hb, loadFont } from '../font/hb.ts';
import { toSfnt } from '../font/io.ts';
import { parseWeightDescriptor } from '../css/values.ts';
import { codePointsOf, parseUnicodeRange } from '../css/unicode-range.ts';
import type { UsageFaceJson } from '../plan/planner.ts';

export const isTypekitSheet = (u: string | undefined): u is string => !!u && /^https?:\/\/use\.typekit\.net\/[a-z0-9]+\.css/i.test(u);

/** What the audit measured in one kit face's file. */
export interface AdobeFaceFacts {
  /** The kit stylesheet. */
  kit: string;
  id: string;
  family: string;
  /** Font Variation Description (`n4`, `i7`). */
  fvd: string;
  bytes: number;
  /** Characters the file maps. */
  cmap: number;
  /** GSUB/GPOS features other than kern and size (what "Include OpenType features" adds). */
  extraFeatures: string[];
  /** Crawled words that shape differently with only kern and size: they need the features. */
  needsFeatures: string[];
  /** The features that make the difference for those words. */
  usedFeatures: string[];
  /** Words checked. */
  words: number;
}

export const fvdOf = (descriptors: Record<string, string>): string => {
  // Adobe's own, from the kit file URL: a variable face (font-weight: 200 900) is n4/i4 there.
  const own = /[?&]fvd=([ni][1-9])\b/.exec(descriptors.src ?? '')?.[1];
  if (own) return own;
  const style = (descriptors['font-style'] ?? 'normal').trim().toLowerCase();
  const [w] = parseWeightDescriptor(descriptors['font-weight']);
  return `${style.startsWith('italic') || style.startsWith('oblique') ? 'i' : 'n'}${Math.round(w / 100)}`;
};

const KEEP = new Set(['kern', 'size']);

type Shaped = string;
function shape(font: hb.Font, text: string, features: string[]): Shaped {
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font, buf, features.map((f) => hb.Feature.fromString(f)!).filter(Boolean));
  const pos = buf.getGlyphPositions();
  return buf.getGlyphInfos().map((g, i) => `${g.codepoint}:${pos[i]!.xAdvance},${pos[i]!.xOffset},${pos[i]!.yOffset}`).join(' ');
}

/**
 * Whether turning the kit's OpenType features off would change any crawled word: each word shaped
 * as the page shaped it, then with every feature but kern and size turned off.
 */
export async function adobeFaceFacts(face: { family: string; descriptors: Record<string, string>; contexts: { features: string; words: string[] }[] }, bytes: Uint8Array, ids: { kit: string; id: string }): Promise<AdobeFaceFacts> {
  const sfnt = await toSfnt(bytes);
  const { face: hf, font } = loadFont(sfnt);
  const tags = [...new Set([...hf.getTableFeatureTags('GSUB'), ...hf.getTableFeatureTags('GPOS')])].toSorted();
  const extra = tags.filter((t) => !KEEP.has(t));
  const off = extra.map((t) => `-${t}`);
  const needs = new Set<string>();
  let words = 0;
  for (const ctx of face.contexts) {
    const feats = ctx.features ? ctx.features.split(',').map((f) => f.trim()).filter(Boolean) : [];
    for (const w of ctx.words) {
      words++;
      if (needs.size >= 20) break;
      if (shape(font, w, feats) !== shape(font, w, [...feats.filter((f) => KEEP.has(f.replace(/^[-+]/, '').slice(0, 4))), ...off])) needs.add(w);
    }
  }
  const used = new Set<string>();
  for (const w of needs) { const base = shape(font, w, []); for (const t of extra) if (!used.has(t) && shape(font, w, [`-${t}`]) !== base) used.add(t); }
  return {
    kit: ids.kit, id: ids.id, family: face.family.replace(/^["']|["']$/g, ''), fvd: fvdOf(face.descriptors), bytes: bytes.byteLength,
    cmap: hf.collectUnicodes().length, extraFeatures: extra, needsFeatures: [...needs].toSorted(), usedFeatures: [...used].toSorted(), words,
  };
}

/**
 * Adobe's Default character set (EN, FR, DE, IT, PT, ES), read from the cmap of Default-set kit files
 * (kits eny7olf and ezf4sbn, 2026-11-03; the code points both have, private use aside): Basic Latin,
 * Latin-1 and these. Note what's missing: ‚ † ‡ ‰ ˆ ƒ.
 */
const DEFAULT_EXTRA = new Set([0x152, 0x153, 0x178, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026, 0x2039, 0x203a, 0x20ac, 0x2122]);
export const inAdobeDefault = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || DEFAULT_EXTRA.has(cp);

export interface AdobeUsage {
  faces: Record<string, Pick<UsageFaceJson, 'family' | 'descriptors' | 'sheet' | 'chars' | 'pages' | 'source'>>;
  unloaded: Record<string, { family: string; descriptors: Record<string, string>; sheet?: string }>;
  pages: Record<string, { fonts: { url: string; status: number; bytes: number }[] }>;
}

/** Findings for each kit: one line of measurements, then one per kit setting worth changing. */
export function adobeFindings(u: AdobeUsage, facts: AdobeFaceFacts[]): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const kits = [...new Set([...Object.values(u.faces), ...Object.values(u.unloaded)].map((f) => f.sheet).filter(isTypekitSheet))].toSorted();
  for (const kit of kits) {
    const name = kit.replace(/^.*\/([a-z0-9]+)\.css.*$/i, '$1');
    const faces = Object.entries(u.faces).filter(([, f]) => f.sheet === kit);
    const perPage = Object.values(u.pages).map((p) => p.fonts.filter((f) => f.status < 400 && /^(https?:\/\/use\.typekit\.net)?\/af\//.test(f.url)).reduce((s, f) => s + f.bytes, 0));
    const max = Math.max(0, ...perPage);
    out.push({ kind: 'adobe-fonts', text: `kit ${name}: ${faces.length} face(s) used, up to ${(max / 1024).toFixed(1)} KB of kit fonts per page. Adobe's license doesn't allow subsetting or self-hosting, so fontphobia changes nothing here; these are settings to change on fonts.adobe.com (Web Projects → ${name})` });
    const unused = Object.values(u.unloaded).filter((f) => f.sheet === kit).map((f) => `${f.family.replace(/^["']|["']$/g, '')} ${fvdOf(f.descriptors)}`).toSorted();
    if (unused.length) out.push({ kind: 'adobe-fonts', text: `kit ${name}: no page uses ${unused.join(', ')}; \`fontphobia apply-kit\` removes those no weight in the code would match, through Adobe's API (keeping, say, a bold style that <strong> would use). Unused styles never download, so this mainly shrinks the kit CSS` });
    const kf = facts.filter((f) => f.kit === kit);
    const needing = kf.filter((f) => f.needsFeatures.length);
    const withExtra = kf.filter((f) => f.extraFeatures.length);
    if (withExtra.length && !needing.length) {
      out.push({ kind: 'adobe-fonts', text: `kit ${name}: none of the ${kf.reduce((s, f) => s + f.words, 0)} crawled words shape differently with only kerning, so "Include OpenType features" can be turned off (it removes ${[...new Set(withExtra.flatMap((f) => f.extraFeatures))].join(' ')}; about half the file size in spike 7). Run \`fontphobia audit\` again afterwards: the kit's files change` });
    } else if (needing.length) {
      out.push({ kind: 'adobe-fonts', text: `kit ${name}: keep "Include OpenType features" on: ${needing.map((f) => `${f.family} ${f.fvd} shapes ${f.needsFeatures.slice(0, 3).map((w) => `"${w.trim()}"`).join(', ')}${f.needsFeatures.length > 3 ? ' …' : ''} with ${f.usedFeatures.join(', ') || 'them'}`).join('; ')}` });
    }
    const outside = new Set<string>();
    for (const [, f] of faces) for (const cp of codePointsOf(parseUnicodeRange(f.chars))) if (!inAdobeDefault(cp)) outside.add(String.fromCodePoint(cp));
    const big = kf.filter((f) => f.cmap > 260);
    if (big.length && outside.size === 0) out.push({ kind: 'adobe-fonts', text: `kit ${name}: every character the pages use is in Adobe's Default set (EN, FR, DE, IT, PT, ES), but ${big.map((f) => `${f.family} ${f.fvd}`).join(', ')} map${big.length === 1 ? 's' : ''} ${Math.max(...big.map((f) => f.cmap))} characters: if the character set is "All Characters", "Default" is smaller; check that every language the site will publish in is in it` });
    else if (outside.size) out.push({ kind: 'adobe-fonts', text: `kit ${name}: the pages use characters outside Adobe's Default set (${[...outside].slice(0, 12).join(' ')}${outside.size > 12 ? ' …' : ''}); keep a character set that includes them` });
    const displays = [...new Set(faces.map(([, f]) => f.descriptors['font-display'] ?? 'auto'))];
    out.push({ kind: 'adobe-fonts', text: `kit ${name}: font-display is ${displays.join(', ')} (kit setting; fontphobia never changes it)` });
  }
  return out;
}
