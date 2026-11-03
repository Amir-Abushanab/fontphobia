// `adobe-fonts` (§6.6): report only. Adobe's license forbids modifying or self-hosting kit fonts, so
// fontphobia never writes them anywhere; the audit inspects the files it already downloaded, in
// memory, and turns what it measures into steps for the kit settings on fonts.adobe.com.
import { hb, loadFont } from '../font/hb.ts';
import { toSfnt } from '../font/io.ts';
import { parseWeightDescriptor } from '../css/values.ts';

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
  const tags = [...new Set([...hf.getTableFeatureTags('GSUB'), ...hf.getTableFeatureTags('GPOS')])].sort();
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
    cmap: hf.collectUnicodes().length, extraFeatures: extra, needsFeatures: [...needs].sort(), usedFeatures: [...used].sort(), words,
  };
}

/** Basic Latin and Latin-1 Supplement: Adobe's Default set covers EN/FR/DE/IT/PT/ES within these and a few more. */
const latin1 = (cp: number) => cp <= 0xff;

export interface AdobeUsage {
  faces: Record<string, { family: string; descriptors: Record<string, string>; sheet?: string; chars: string; pages: string[]; source: { adapter: string } }>;
  unloaded: Record<string, { family: string; descriptors: Record<string, string>; sheet?: string }>;
  pages: Record<string, { fonts: { url: string; status: number; bytes: number }[] }>;
}

/** Findings for each kit: one line of measurements, then one per kit setting worth changing. */
export function adobeFindings(u: AdobeUsage, facts: AdobeFaceFacts[]): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const kits = [...new Set([...Object.values(u.faces), ...Object.values(u.unloaded)].map((f) => f.sheet).filter(isTypekitSheet))].sort();
  for (const kit of kits) {
    const name = kit.replace(/^.*\/([a-z0-9]+)\.css.*$/i, '$1');
    const faces = Object.entries(u.faces).filter(([, f]) => f.sheet === kit);
    const perPage = Object.values(u.pages).map((p) => p.fonts.filter((f) => f.status < 400 && /^(https?:\/\/use\.typekit\.net)?\/af\//.test(f.url)).reduce((s, f) => s + f.bytes, 0));
    const max = Math.max(0, ...perPage);
    out.push({ kind: 'adobe-fonts', text: `kit ${name}: ${faces.length} face(s) used, up to ${(max / 1024).toFixed(1)} KB of kit fonts per page. Adobe's license doesn't allow subsetting or self-hosting, so fontphobia changes nothing here; these are settings to change on fonts.adobe.com (Web Projects → ${name})` });
    const unused = Object.values(u.unloaded).filter((f) => f.sheet === kit).map((f) => `${f.family.replace(/^["']|["']$/g, '')} ${fvdOf(f.descriptors)}`).sort();
    if (unused.length) out.push({ kind: 'adobe-fonts', text: `kit ${name}: no page uses ${unused.join(', ')}; remove ${unused.length > 1 ? 'these styles' : 'this style'} from the project (unused styles never download, so this mainly shrinks the kit CSS)` });
    const kf = facts.filter((f) => f.kit === kit);
    const needing = kf.filter((f) => f.needsFeatures.length);
    const withExtra = kf.filter((f) => f.extraFeatures.length);
    if (withExtra.length && !needing.length) {
      out.push({ kind: 'adobe-fonts', text: `kit ${name}: none of the ${kf.reduce((s, f) => s + f.words, 0)} crawled words shape differently with only kerning, so "Include OpenType features" can be turned off (it removes ${[...new Set(withExtra.flatMap((f) => f.extraFeatures))].join(' ')}; about half the file size in spike 7). Run \`fontphobia audit\` again afterwards: the kit's files change` });
    } else if (needing.length) {
      out.push({ kind: 'adobe-fonts', text: `kit ${name}: keep "Include OpenType features" on: ${needing.map((f) => `${f.family} ${f.fvd} shapes ${f.needsFeatures.slice(0, 3).map((w) => `"${w.trim()}"`).join(', ')}${f.needsFeatures.length > 3 ? ' …' : ''} with ${f.usedFeatures.join(', ') || 'them'}`).join('; ')}` });
    }
    const outside = new Set<string>();
    for (const [, f] of faces) for (const ch of f.chars) if (!latin1(ch.codePointAt(0)!)) outside.add(ch);
    const big = kf.filter((f) => f.cmap > 260);
    if (big.length && outside.size === 0) out.push({ kind: 'adobe-fonts', text: `kit ${name}: the pages use only Basic Latin and Latin-1 characters, but ${big.map((f) => `${f.family} ${f.fvd}`).join(', ')} map${big.length === 1 ? 's' : ''} ${Math.max(...big.map((f) => f.cmap))} characters: if the character set is "All Characters", "Default" (EN, FR, DE, IT, PT, ES) is smaller; check that the site's languages are in it` });
    else if (outside.size) out.push({ kind: 'adobe-fonts', text: `kit ${name}: the pages use characters beyond Latin-1 (${[...outside].slice(0, 12).join(' ')}${outside.size > 12 ? ' …' : ''}); keep a character set that includes them` });
    const displays = [...new Set(faces.map(([, f]) => f.descriptors['font-display'] ?? 'auto'))];
    out.push({ kind: 'adobe-fonts', text: `kit ${name}: font-display is ${displays.join(', ')} (kit setting; fontphobia never changes it)` });
  }
  return out;
}
