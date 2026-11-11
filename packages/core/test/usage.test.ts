import { describe, expect, it } from 'vitest';
import {
  applyDeclared, buildUsage, canonicalJson, charsToRanges, contentCounterStyles, counterChars, ellipsisChars, emphasisChars,
  fullSizeKana, fullWidth, hyphenChars, maskChars, matchFaces, parseStylesheet, quoteChars, STYLE_PROPS, styleOf,
  synthesizedCapsChars, usageToJson, weightSteps,
  type CapturedFace, type FontFacts, type Run, type StyleRow, type Visit,
} from '../src/index.ts';

const W = (weight: [number, number], style: 'normal' | 'italic' = 'normal') => ({ weight, style: { kind: style } as const, stretch: [100, 100] as [number, number], unicodeRange: [[0, 0x10ffff]] as [number, number][] });

describe('font matching (CSS Fonts 4 §5.2)', () => {
  const faces = [W([300, 300]), W([400, 400]), W([700, 700]), W([400, 400], 'italic'), W([900, 900])].map((f, i) => ({ ...f, i }));
  const pick = (weight: number, style: 'normal' | 'italic' = 'normal') => matchFaces(faces, { weight, style: { kind: style }, stretch: 100 }).map((f) => f.i);
  it('picks weights in the spec order', () => {
    expect(pick(400)).toEqual([1]);
    expect(pick(450)).toEqual([1]); // 400–500: up to 500, then below
    expect(pick(500)).toEqual([1]);
    expect(pick(600)).toEqual([2]); // > 500: heavier first
    expect(pick(350)).toEqual([0]); // < 400: lighter first
    expect(pick(200)).toEqual([0]); // nothing lighter: heavier
    expect(pick(950)).toEqual([4]);
  });
  it('prefers style before weight', () => {
    expect(pick(700, 'italic')).toEqual([3]);
  });
  it('matches inside variable ranges and returns faces in reverse definition order', () => {
    const v = [{ ...W([100, 900]), i: 0 }, { ...W([100, 900]), i: 1 }];
    expect(matchFaces(v, { weight: 650, style: { kind: 'normal' }, stretch: 100 }).map((f) => f.i)).toEqual([1, 0]);
  });
});

describe('§7.4 rules', () => {
  it('hyphens', () => {
    expect(hyphenChars('auto', 'auto', 'x')).toBe('‐-');
    expect(hyphenChars('auto', '"="', 'x')).toBe('‐-=');
    expect(hyphenChars('manual', 'auto', 'soft­hyphen')).toBe('‐-');
    expect(hyphenChars('manual', 'auto', 'none')).toBe('');
  });
  it('ellipsis and line-clamp', () => {
    expect(ellipsisChars('ellipsis', 'none')).toBe('….');
    expect(ellipsisChars('clip', '3')).toBe('….');
    expect(ellipsisChars('"→" ellipsis', 'none')).toBe('→….');
    expect(ellipsisChars('clip', 'none')).toBe('');
  });
  it('masking', () => {
    expect(maskChars('password', 'none')).toBe('•●');
    expect(maskChars('text', 'square')).toBe('■');
    expect(maskChars('text', 'circle')).toBe('◦');
  });
  it('synthesized small caps only when the face lacks the feature', () => {
    expect(synthesizedCapsChars('small-caps', new Set(), 'Small caps', 'en')).toBe('MALCP');
    expect(synthesizedCapsChars('small-caps', new Set(['smcp']), 'Small caps', 'en')).toBe('');
    expect(synthesizedCapsChars('all-small-caps', new Set(['smcp']), 'ab', 'en')).toBe('AB');
    expect(synthesizedCapsChars('small-caps', new Set(), 'istanbul', 'tr')).toContain('İ');
  });
  it('full-width and full-size kana', () => {
    expect(fullWidth('AB c')).toBe('ＡＢ　ｃ');
    expect(fullSizeKana('ぁァㇰ')).toBe('あアク');
  });
  it('text-emphasis', () => {
    expect(emphasisChars('filled sesame', 'horizontal-tb')).toBe('﹅');
    expect(emphasisChars('open', 'vertical-rl')).toBe('﹆');
    expect(emphasisChars('filled', 'horizontal-tb')).toBe('●');
    expect(emphasisChars('"*"', 'horizontal-tb')).toBe('*');
    expect(emphasisChars('none', 'horizontal-tb')).toBe('');
  });
  it('counter styles produce every character they can', () => {
    expect(counterChars('upper-roman')).toBe('IVXLCDM-. ');
    expect(counterChars('disc')).toBe('• ');
    expect(counterChars('"→ "')).toBe('→ ');
    const custom = parseStylesheet('@counter-style t { system: cyclic; symbols: "✓"; suffix: " "; } @counter-style u { system: extends lower-greek; prefix: "("; }').counterStyles;
    expect(counterChars('t', custom)).toBe('✓ -0123456789-. ');
    expect(counterChars('u', custom)).toContain('(');
    expect(counterChars('u', custom)).toContain('ω');
    expect(contentCounterStyles('counter(c, upper-roman) ". "')).toEqual(['upper-roman']);
    expect(contentCounterStyles('counters(sec, "-", lower-alpha)')).toEqual(['lower-alpha', '"-"']);
    expect(contentCounterStyles('counter(n)')).toEqual(['decimal']);
  });
  it('CLDR quotes with locale fallback', () => {
    expect(quoteChars('de')).toBe('„“‚‘');
    expect(quoteChars('fr-CA')).toContain('«');
    expect(quoteChars('xx')).toBe(quoteChars('en'));
  });
});

const BASE: Record<string, string> = {
  'font-family': 'Inter, sans-serif', 'font-weight': '400', 'font-style': 'normal', 'font-stretch': '100%', 'font-size': '16px',
  'font-variation-settings': 'normal', 'font-feature-settings': 'normal', 'font-variant-ligatures': 'normal', 'font-variant-caps': 'normal',
  'font-variant-numeric': 'normal', 'font-variant-east-asian': 'normal', 'font-variant-position': 'normal', 'font-variant-alternates': 'normal',
  'font-kerning': 'auto', 'font-optical-sizing': 'auto', 'font-synthesis': 'weight style small-caps', 'letter-spacing': 'normal',
  'text-transform': 'none', hyphens: 'manual', 'hyphenate-character': 'auto', 'text-overflow': 'clip', '-webkit-line-clamp': 'none',
  'text-emphasis-style': 'none', '-webkit-text-security': 'none', 'writing-mode': 'horizontal-tb', '-webkit-locale': '"en"',
  'list-style-type': 'disc', content: 'normal', 'animation-name': 'none',
};
const row = (o: Record<string, string> = {}): StyleRow => STYLE_PROPS.map((p) => o[p] ?? BASE[p]!);

describe('declared values', () => {
  it('applies longhands, relative weights and the font shorthand', () => {
    expect(styleOf(applyDeclared(row({ 'font-weight': '600' }), { 'font-weight': 'bolder' }))['font-weight']).toBe('900');
    const s = styleOf(applyDeclared(row({ 'font-variation-settings': '"wght" 300' }), { font: 'italic small-caps bold condensed 20px/1.2 "Deja", serif' }));
    expect([s['font-style'], s['font-variant-caps'], s['font-weight'], s['font-stretch'], s['font-size'], s['font-family'], s['font-variation-settings']])
      .toEqual(['italic', 'small-caps', '700', '75%', '20px', '"Deja", serif', 'normal']);
    expect(styleOf(applyDeclared(row(), { 'font-weight': 'var(--w)' }))['font-weight']).toBe('400');
  });
  it('steps animated weights by 100', () => {
    expect(weightSteps(300, 600)).toEqual([300, 400, 500, 600]);
    expect(weightSteps(450, 450)).toEqual([450]);
  });
});

// A synthetic site: Inter normal (Latin + ext slices), Inter italic, and a face that never draws.
const LATIN = new Set([...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i), 0x2026, 0x2010, 0x2022, 0x25cf, 0x201c, 0x201d]);
const EXT = new Set([0x103, 0x219, 0x21a, 0x21b, 0x1ebf, 0x1ec7]);
const facts = new Map<string, FontFacts>([
  ['latin', { sha256: 'latin', cmap: LATIN, features: new Set(['kern', 'tnum']), axes: [{ tag: 'wght', min: 100, default: 400, max: 900 }, { tag: 'opsz', min: 14, default: 14, max: 32 }] }],
  ['ext', { sha256: 'ext', cmap: EXT, features: new Set(['kern']), axes: [{ tag: 'wght', min: 100, default: 400, max: 900 }] }],
  ['italic', { sha256: 'italic', cmap: LATIN, features: new Set(), axes: [] }],
  ['other', { sha256: 'other', cmap: LATIN, features: new Set(), axes: [] }],
]);
const face = (family: string, url: string, extra: Partial<CapturedFace> = {}): CapturedFace => ({
  family, src: [{ url }], urls: [`http://x/${url}`], unicodeRange: [[0, 0x10ffff]], weight: [100, 900], style: { kind: 'normal' }, stretch: [100, 100],
  descriptors: { 'font-family': family, src: `url(${url})`, 'font-weight': '100 900' }, start: 0, end: 0, line: 1, wrappers: [], computed: false, sheet: 'http://x/s.css', ...extra,
});
const FACES: CapturedFace[] = [
  face('Inter', 'latin.woff2', { unicodeRange: [[0, 0xff], [0x2000, 0x206f], [0x25cf, 0x25cf]], descriptors: { 'font-family': 'Inter', 'font-weight': '100 900', 'unicode-range': 'U+0-FF, U+2000-206F, U+25CF', src: 'url(latin.woff2)' } }),
  face('Inter', 'ext.woff2', { unicodeRange: [[0x100, 0x24f], [0x1e00, 0x1eff]], descriptors: { 'font-family': 'Inter', 'font-weight': '100 900', 'unicode-range': 'U+100-24F, U+1E00-1EFF', src: 'url(ext.woff2)' } }),
  face('Inter', 'italic.woff2', { style: { kind: 'italic' }, descriptors: { 'font-family': 'Inter', 'font-weight': '100 900', 'font-style': 'italic', src: 'url(italic.woff2)' } }),
  face('Unused', 'other.woff2', { descriptors: { 'font-family': 'Unused', src: 'url(other.woff2)' } }),
];
const fonts = ['latin', 'ext', 'italic', 'other'].map((n) => ({ url: `http://x/${n}.woff2`, status: 200, bytes: 1000, transfer: 1000, sha256: n }));

function visit(page: string, runs: Run[], styles: StyleRow[], extra: Partial<Visit> = {}): Visit {
  return { page, url: `http://x${page}`, viewport: 1280, fontSize: 16, styles, runs, declared: [], faces: FACES, featureValues: [], counterStyles: [], keyframes: [], fonts, preloads: [], platform: [], locales: {}, lang: 'en', notes: [], ...extra };
}

describe('buildUsage', () => {
  const styles = [
    row(),
    row({ 'font-style': 'italic', 'font-weight': '700' }),
    row({ 'text-overflow': 'ellipsis' }),
    row({ 'font-variant-numeric': 'tabular-nums', 'font-size': '24px' }),
    row({ 'font-family': '"Not Installed", Inter', 'font-weight': '650' }),
  ];
  const v1 = visit('/', [
    { text: 'Hello Țară', style: 0, kind: 'text' },
    { text: 'bold', style: 1, kind: 'text' },
    { text: 'Tiếng ☃', style: 0, kind: 'text' },
    { text: 'long', style: 0, kind: 'text', ellipsis: 2 },
    { text: '12', style: 3, kind: 'text', q: true },
    { text: 'x', style: 4, kind: 'text' },
    { text: '', style: 0, kind: 'password', editable: true },
  ], styles, {
    preloads: [{ href: 'http://x/latin.woff2', crossorigin: '' }, { href: 'http://x/other.woff2', crossorigin: null }],
    platform: [{ runs: [5], fonts: [{ family: 'Inter', postscript: 'Inter', custom: true, glyphs: 1 }] }],
    declared: [{ runs: [0], decls: { 'font-weight': '800' }, origin: ':hover' }],
  });
  const v2 = visit('/about/', [{ text: 'About', style: 0, kind: 'text' }], styles);
  const u = buildUsage([v2, v1], facts, { locales: ['de'] });
  const byFile = (f: string) => [...u.faces.values()].find((x) => x.urls[0]!.endsWith(f))!;

  it('attributes characters per face through unicode-range and cmap', () => {
    expect(charsToRanges(byFile('latin.woff2').chars)).toBe(charsToRanges([...'Hello ar Ting long12x About'].map((c) => c.codePointAt(0)!).concat([0x2026, 0x2e, 0x2022, 0x25cf, 0x201e, 0x201c, 0x201a, 0x2018])));
    expect(charsToRanges(byFile('ext.woff2').chars)).toBe('U+103, U+21A, U+1EBF');
  });
  it('puts bold inside italic into the italic face', () => {
    const it = byFile('italic.woff2');
    expect([...it.chars].map((c) => String.fromCodePoint(c)).sort().join('')).toBe('bdlo');
    expect([...it.rendered.weight]).toEqual([700]);
  });
  it('records system fallback, inserted characters and declared states', () => {
    expect(charsToRanges(u.pages.get('/')!.fallback.get('sans-serif')!)).toBe('U+2603');
    const l = byFile('latin.woff2');
    expect(charsToRanges(l.inserted.get('text-overflow')!)).toBe('U+2E, U+2026');
    expect(charsToRanges(l.inserted.get('password')!)).toBe('U+2022, U+25CF');
    expect(charsToRanges(l.inserted.get('quotes (de)')!)).toBe('U+2018, U+201A, U+201C, U+201E');
    expect([...l.declared.weight]).toEqual([800]);
    expect(l.editable).toBe(true);
    expect(l.features.has('tnum')).toBe(true);
    expect([...l.rendered.axes.get('opsz')!].sort()).toEqual([16, 24]);
    expect([...l.rendered.axes.get('wght')!].sort()).toEqual([400, 650]);
  });
  it('records characters drawn in text set in a system font, apart from fallback', () => {
    const mono = [row(), row({ 'font-family': 'monospace' })];
    const p = buildUsage([visit('/code', [{ text: 'a ≤ b', style: 1, kind: 'text' }, { text: 'Hi', style: 0, kind: 'text' }], mono)], facts).pages.get('/code')!;
    expect(charsToRanges(p.system)).toBe('U+61-62, U+2264');
    expect(p.fallback.size).toBe(0);
    expect(u.pages.get('/')!.system.size).toBe(0);
  });
  it('skips fonts that are not installed in a stack', () => {
    expect(byFile('latin.woff2').chars.has('x'.codePointAt(0)!)).toBe(true);
    expect(u.pages.get('/')!.fallback.has('Not Installed')).toBe(false);
  });
  it('splits words into per-face segments with their context', () => {
    const l = byFile('latin.woff2');
    const words = [...l.contexts.values()].flatMap((c) => [...c.words]);
    expect(words).toContain('Hello ');
    expect(words).toContain('ar'); // "Țară": Ț and ă go to ext, "ar" to latin
    const ext = [...byFile('ext.woff2').contexts.values()].flatMap((c) => [...c.words]);
    expect(ext.sort()).toEqual([' Ț', 'ă', 'ế']);
  });
  it('reports preloads and unloaded faces', () => {
    const p = u.pages.get('/')!.preloads;
    expect(p.get('/latin.woff2')!.used).toBe(true);
    expect(p.get('/other.woff2')!.used).toBe(false);
    expect([...u.unloaded.values()].map((x) => x.family)).toEqual(['Unused']);
    expect([...u.faces.values()].map((x) => x.family)).not.toContain('Unused');
  });
  it('serializes canonically and independently of visit order', () => {
    const meta = { fontphobia: '0', harfbuzz: '0', chrome: '0', framework: 'static', mode: 'static' as const, viewports: [1280], fontSizes: [16] };
    const a = canonicalJson(usageToJson(u, meta));
    const b = canonicalJson(usageToJson(buildUsage([v1, v2], facts, { locales: ['de'] }), meta));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(a).faces).map((k) => k.replace(/[0-9a-f]{6}$/, '#'))).toEqual(['inter-100-900-italic', 'inter-100-900-normal-#', 'inter-100-900-normal-#']);
  });
  it('stores no words for private pages', () => {
    const p = buildUsage([visit('/account', [{ text: 'Secret words', style: 0, kind: 'text' }], styles, { private: true })], facts);
    const l = [...p.faces.values()][0]!;
    expect(l.chars.size).toBeGreaterThan(0);
    expect(l.contexts.size).toBe(0);
  });
});
