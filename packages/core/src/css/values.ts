// Parsing of CSS font values: family lists, weight/style/stretch (descriptor ranges and
// computed values), feature and variation settings, and the font-variant-* → tag table (§7.5).

/** Split on a separator outside quotes and parentheses. */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) { if (cur.trim() || sep !== ' ') out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() || (sep !== ' ' && out.length)) out.push(cur.trim());
  return out.filter((x) => sep !== ' ' || x);
}

/** Remove quotes and CSS escapes from a string or identifier sequence. */
export function unquote(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, e: string) => (/^[0-9a-f]/i.test(e) && e.trim().length ? String.fromCodePoint(parseInt(e, 16)) : e));
}

export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont',
]);

/** "Inter Variable", Inter, sans-serif → ['Inter Variable', 'Inter', 'sans-serif']. Unquoted names collapse whitespace. */
export function parseFamilyList(value: string): string[] {
  return splitTop(value).map((f) => {
    const q = /^["']/.test(f.trim());
    const u = unquote(f);
    return q ? u : u.replace(/\s+/g, ' ');
  }).filter(Boolean);
}

/** CSS family names match ASCII case-insensitively. */
export const familyKey = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

export type Interval = [number, number];

const WEIGHT_KW: Record<string, number> = { normal: 400, bold: 700 };
export function parseWeightDescriptor(v: string | undefined): Interval {
  if (!v) return [400, 400];
  const p = v.trim().toLowerCase().split(/\s+/);
  if (p[0] === 'auto') return [1, 1000];
  const n = p.map((x) => WEIGHT_KW[x] ?? Number(x));
  if (n.some((x) => !Number.isFinite(x))) return [400, 400];
  return n.length > 1 ? [Math.min(n[0]!, n[1]!), Math.max(n[0]!, n[1]!)] : [n[0]!, n[0]!];
}

export const STRETCH_KW: Record<string, number> = {
  'ultra-condensed': 50, 'extra-condensed': 62.5, condensed: 75, 'semi-condensed': 87.5, normal: 100,
  'semi-expanded': 112.5, expanded: 125, 'extra-expanded': 150, 'ultra-expanded': 200,
};
const stretchValue = (x: string): number => STRETCH_KW[x] ?? (x.endsWith('%') ? Number(x.slice(0, -1)) : NaN);
export function parseStretchDescriptor(v: string | undefined): Interval {
  if (!v) return [100, 100];
  const p = v.trim().toLowerCase().split(/\s+/);
  if (p[0] === 'auto') return [50, 200];
  const n = p.map(stretchValue);
  if (n.some((x) => !Number.isFinite(x))) return [100, 100];
  return n.length > 1 ? [Math.min(n[0]!, n[1]!), Math.max(n[0]!, n[1]!)] : [n[0]!, n[0]!];
}
export const parseComputedStretch = (v: string): number => {
  const n = stretchValue(v.trim().toLowerCase());
  return Number.isFinite(n) ? n : 100;
};

/** Font style as a slant interval in degrees: normal = [0,0], italic = 'italic', oblique = angles. */
export type StyleValue = { kind: 'normal' } | { kind: 'italic' } | { kind: 'oblique'; min: number; max: number };
const angle = (x: string): number => {
  const m = x.match(/^(-?[\d.]+)(deg|grad|rad|turn)?$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === 'rad' ? (n * 180) / Math.PI : m[2] === 'grad' ? n * 0.9 : m[2] === 'turn' ? n * 360 : n;
};
export function parseStyle(v: string | undefined): StyleValue {
  const p = (v ?? 'normal').trim().toLowerCase().split(/\s+/);
  if (p[0] === 'italic') return { kind: 'italic' };
  if (p[0] === 'oblique') {
    const a = p.slice(1).map(angle).filter(Number.isFinite);
    if (!a.length) return { kind: 'oblique', min: 14, max: 14 };
    return { kind: 'oblique', min: Math.min(...a), max: Math.max(...a) };
  }
  if (p[0] === 'auto') return { kind: 'oblique', min: -90, max: 90 };
  return { kind: 'normal' };
}
export const formatStyle = (s: StyleValue): string =>
  s.kind === 'oblique' ? (s.min === s.max ? `oblique ${s.min}deg` : `oblique ${s.min}deg ${s.max}deg`) : s.kind;

export const formatInterval = (i: Interval, unit = ''): string => (i[0] === i[1] ? `${i[0]}${unit}` : `${i[0]}${unit} ${i[1]}${unit}`);

/** `"tnum", "ss01" 2, "liga" off` → [['tnum', 1], ['ss01', 2], ['liga', 0]]. `normal` → []. */
export function parseFeatureSettings(v: string | undefined): [string, number][] {
  if (!v || v.trim() === 'normal') return [];
  const out: [string, number][] = [];
  for (const part of splitTop(v)) {
    const m = part.match(/^(["'])([\x20-\x7e]{4})\1\s*(on|off|\d+)?$/i);
    if (!m) continue;
    const val = m[3] === undefined || m[3].toLowerCase() === 'on' ? 1 : m[3].toLowerCase() === 'off' ? 0 : Number(m[3]);
    out.push([m[2]!, val]);
  }
  return out;
}

/** `"wght" 650, "opsz" 32` → [['wght', 650], ['opsz', 32]]. */
export function parseVariationSettings(v: string | undefined): [string, number][] {
  if (!v || v.trim() === 'normal') return [];
  const out: [string, number][] = [];
  for (const part of splitTop(v)) {
    const m = part.match(/^(["'])([\x20-\x7e]{4})\1\s*(-?[\d.]+(?:e-?\d+)?)$/i);
    if (m) out.push([m[2]!, Number(m[3])]);
  }
  return out;
}

/** @font-feature-values: family key → type (styleset, character-variant, …) → name → indices. */
export type FeatureValues = Map<string, Map<string, Map<string, number[]>>>;

export interface VariantStyle {
  fontVariantLigatures?: string;
  fontVariantCaps?: string;
  fontVariantNumeric?: string;
  fontVariantEastAsian?: string;
  fontVariantPosition?: string;
  fontVariantAlternates?: string;
  fontKerning?: string;
  letterSpacing?: string;
}

const LIGATURES: Record<string, [string, number][]> = {
  'common-ligatures': [['liga', 1], ['clig', 1]], 'no-common-ligatures': [['liga', 0], ['clig', 0]],
  'discretionary-ligatures': [['dlig', 1]], 'no-discretionary-ligatures': [['dlig', 0]],
  'historical-ligatures': [['hlig', 1]], 'no-historical-ligatures': [['hlig', 0]],
  contextual: [['calt', 1]], 'no-contextual': [['calt', 0]],
  none: [['liga', 0], ['clig', 0], ['dlig', 0], ['hlig', 0], ['calt', 0]],
};
const CAPS: Record<string, string[]> = {
  'small-caps': ['smcp'], 'all-small-caps': ['c2sc', 'smcp'], 'petite-caps': ['pcap'], 'all-petite-caps': ['c2pc', 'pcap'],
  unicase: ['unic'], 'titling-caps': ['titl'],
};
const NUMERIC: Record<string, string> = {
  'lining-nums': 'lnum', 'oldstyle-nums': 'onum', 'proportional-nums': 'pnum', 'tabular-nums': 'tnum',
  'diagonal-fractions': 'frac', 'stacked-fractions': 'afrc', ordinal: 'ordn', 'slashed-zero': 'zero',
};
const EAST_ASIAN: Record<string, string> = {
  jis78: 'jp78', jis83: 'jp83', jis90: 'jp90', jis04: 'jp04', simplified: 'smpl', traditional: 'trad',
  'full-width': 'fwid', 'proportional-width': 'pwid', ruby: 'ruby',
};
const ALT_TYPES: Record<string, string> = {
  stylistic: 'stylistic', styleset: 'styleset', 'character-variant': 'character-variant', swash: 'swash', ornaments: 'ornaments', annotation: 'annotation',
};

/** The small-caps family of values, which browsers synthesize when the font lacks the feature (§7.4). */
export const capsFeatures = (caps: string | undefined): string[] => CAPS[(caps ?? 'normal').trim()] ?? [];

/**
 * Feature settings a computed style applies, in CSS order of precedence (§7.5):
 * font-variant-* first, then font-feature-settings overrides. letter-spacing ≠ 0 turns off
 * optional ligatures in Chrome. Returns tag → value (0 means explicitly off).
 */
export function featuresOf(style: VariantStyle & { fontFeatureSettings?: string }, family: string | undefined, fv?: FeatureValues, descriptorFeatures?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [t, v] of parseFeatureSettings(descriptorFeatures)) out.set(t, v);
  const words = (s: string | undefined) => (s && s.trim() !== 'normal' ? splitTop(s.trim(), ' ') : []);
  const lig = (style.fontVariantLigatures ?? 'normal').trim();
  if (lig === 'none') for (const [t, v] of LIGATURES.none!) out.set(t, v);
  else for (const w of words(lig)) for (const [t, v] of LIGATURES[w] ?? []) out.set(t, v);
  for (const t of capsFeatures(style.fontVariantCaps)) out.set(t, 1);
  for (const w of words(style.fontVariantNumeric)) if (NUMERIC[w]) out.set(NUMERIC[w]!, 1);
  for (const w of words(style.fontVariantEastAsian)) if (EAST_ASIAN[w]) out.set(EAST_ASIAN[w]!, 1);
  const pos = (style.fontVariantPosition ?? 'normal').trim();
  if (pos === 'sub') out.set('subs', 1);
  else if (pos === 'super') out.set('sups', 1);
  for (const w of words(style.fontVariantAlternates)) {
    if (w === 'historical-forms') { out.set('hist', 1); continue; }
    const m = w.match(/^([a-z-]+)\((.*)\)$/);
    if (!m || !ALT_TYPES[m[1]!]) continue;
    const names = splitTop(m[2]!).map((n) => unquote(n));
    const lookup = (n: string) => (family ? fv?.get(familyKey(family))?.get(m[1]!)?.get(n) : undefined);
    for (const n of names) {
      const idx = lookup(n);
      if (!idx?.length) continue;
      switch (m[1]) {
        case 'stylistic': out.set('salt', idx[0]!); break;
        case 'swash': out.set('swsh', idx[0]!); out.set('cswh', idx[0]!); break;
        case 'ornaments': out.set('ornm', idx[0]!); break;
        case 'annotation': out.set('nalt', idx[0]!); break;
        case 'styleset': for (const i of idx) if (i >= 1 && i <= 20) out.set(`ss${String(i).padStart(2, '0')}`, 1); break;
        case 'character-variant': if (idx[0]! >= 1 && idx[0]! <= 99) out.set(`cv${String(idx[0]).padStart(2, '0')}`, idx[1] ?? 1); break;
      }
    }
  }
  if ((style.fontKerning ?? 'auto').trim() === 'none') out.set('kern', 0);
  const ls = (style.letterSpacing ?? 'normal').trim();
  if (ls !== 'normal' && parseFloat(ls) !== 0) for (const t of ['liga', 'clig', 'dlig', 'hlig', 'calt']) if (!out.has(t)) out.set(t, 0);
  for (const [t, v] of parseFeatureSettings(style.fontFeatureSettings)) out.set(t, v);
  return out;
}

/** Canonical "tag=value" list, sorted. */
export const formatSettings = (m: Map<string, number> | [string, number][]): string =>
  [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([t, v]) => `${t}=${v}`).join(',');

/** CSS relative weights (CSS Fonts 4 §2.2 table). */
export function relativeWeight(kw: 'bolder' | 'lighter', parent: number): number {
  if (kw === 'bolder') return parent < 350 ? 400 : parent < 550 ? 700 : parent < 900 ? 900 : parent;
  return parent < 100 ? parent : parent < 550 ? 100 : parent < 750 ? 400 : 700;
}
