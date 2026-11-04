// Stylesheet model (PostCSS): @font-face, @font-feature-values, @counter-style, and the style
// rules that declare font values the crawl may never trigger (§7.5 "declared values").
import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Root, type Rule } from 'postcss';
import postcssScss from 'postcss-scss';
import postcssLess from 'postcss-less';
import selectorParser from 'postcss-selector-parser';
import { parseUnicodeRange, type Range } from './unicode-range.ts';
import {
  familyKey, parseFamilyList, parseStretchDescriptor, parseStyle, parseWeightDescriptor, splitTop, unquote,
  type FeatureValues, type Interval, type StyleValue,
} from './values.ts';

export interface SrcEntry { url?: string; local?: string; format?: string; tech?: string }

export interface FontFaceRule {
  family: string;
  src: SrcEntry[];
  unicodeRange: Range[];
  weight: Interval;
  style: StyleValue;
  stretch: Interval;
  /** Every descriptor as written, lowercased name → value (src included). */
  descriptors: Record<string, string>;
  /** Source position of the whole rule (offsets into the text, 1-based line). */
  start: number;
  end: number;
  line: number;
  /** Enclosing at-rules, outermost first: "@media (min-width: 40em)", "@layer base". */
  wrappers: string[];
  /** The src contains something we can't resolve statically (Sass/Less variables, interpolation). */
  computed: boolean;
}

export interface CounterStyle { name: string; system: string; symbols: string[]; additive: string[]; prefix?: string; suffix?: string; pad?: string; negative?: string; fallback?: string; extends?: string }

/** A style rule that sets font values, with dynamic pseudo-classes stripped from its selectors. */
export interface DeclaredRule {
  /** Selector with :hover/:focus/… removed; empty means "never matches statically". */
  selectors: { base: string; pseudo?: string; states: string[] }[];
  decls: Record<string, string>;
  wrappers: string[];
}

export interface Keyframes { name: string; frames: Record<string, string>[] }

export interface Stylesheet {
  fontFaces: FontFaceRule[];
  featureValues: FeatureValues;
  counterStyles: CounterStyle[];
  declared: DeclaredRule[];
  keyframes: Keyframes[];
  /** Selectors of rules with `text-transform: full-width | full-size-kana` (Chrome drops these values, §7.4). */
  textTransforms: { selector: string; value: 'full-width' | 'full-size-kana' }[];
  /** Base selectors of ::first-line rules that set a font. */
  firstLine: string[];
  /** Media queries using em/rem (the font-size sweep adds sizes, §7.2). */
  emMediaQueries: boolean;
  errors: string[];
}

export type Syntax = 'css' | 'scss' | 'less';

const FONT_PROPS = new Set([
  'font', 'font-family', 'font-weight', 'font-style', 'font-stretch', 'font-width', 'font-variation-settings', 'font-feature-settings',
  'font-variant', 'font-variant-ligatures', 'font-variant-caps', 'font-variant-numeric', 'font-variant-east-asian',
  'font-variant-position', 'font-variant-alternates', 'font-kerning', 'font-optical-sizing', 'font-size', 'letter-spacing',
]);

const STATE_PSEUDOS = new Set([
  ':hover', ':focus', ':focus-visible', ':focus-within', ':active', ':visited', ':target', ':target-within', ':checked', ':disabled',
  ':enabled', ':indeterminate', ':invalid', ':valid', ':user-invalid', ':user-valid', ':placeholder-shown', ':popover-open', ':open',
  ':autofill', ':-webkit-autofill', ':default', ':in-range', ':out-of-range', ':read-only', ':read-write', ':required', ':optional',
  ':playing', ':paused', ':current', ':past', ':future', ':fullscreen', ':modal', ':picture-in-picture',
]);
const PSEUDO_ELEMENTS = new Set(['::before', '::after', '::marker', '::first-letter', '::first-line', '::placeholder', '::file-selector-button', '::backdrop', '::selection', ':before', ':after', ':first-letter', ':first-line']);

export function splitSelector(selector: string): DeclaredRule['selectors'] {
  const out: DeclaredRule['selectors'] = [];
  try {
    selectorParser((root) => {
      root.each((sel) => {
        const states: string[] = [];
        let pseudo: string | undefined;
        sel.walkPseudos((p) => {
          const v = p.value.toLowerCase();
          if (PSEUDO_ELEMENTS.has(v)) { pseudo = v.replace(/^:+/, '::'); p.remove(); }
          else if (STATE_PSEUDOS.has(v) && !p.nodes.length) { states.push(v); p.remove(); }
        });
        let base = sel.toString().trim();
        if (!base || /[>+~]$/.test(base)) base = (base + ' *').trim().replace(/^\*$/, '*');
        if (!base) base = '*';
        out.push({ base, pseudo, states });
      });
    }).processSync(selector);
  } catch { /* unparseable selector: never matches */ }
  return out;
}

function parseSrc(value: string): { src: SrcEntry[]; computed: boolean } {
  const src: SrcEntry[] = [];
  let computed = /[#$@]\{|\$[\w-]|@[\w-]|var\(/.test(value);
  for (const part of splitTop(value)) {
    const e: SrcEntry = {};
    const url = part.match(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/i);
    if (url) e.url = unquote(url[1] ?? url[2] ?? url[3] ?? '');
    const local = part.match(/local\(\s*(.*?)\s*\)/i);
    if (local) e.local = unquote(local[1]!);
    const fmt = part.match(/format\(\s*(.*?)\s*\)/i);
    if (fmt) e.format = unquote(fmt[1]!);
    const tech = part.match(/tech\(\s*(.*?)\s*\)/i);
    if (tech) e.tech = tech[1]!.trim();
    if (e.url !== undefined || e.local !== undefined) src.push(e);
    else if (part.trim()) computed = true;
  }
  return { src, computed };
}

function wrappersOf(node: ChildNode): string[] {
  const w: string[] = [];
  for (let p: Container | undefined = node.parent as Container | undefined; p && p.type !== 'root'; p = p.parent as Container | undefined) {
    if (p.type === 'atrule') { const a = p as AtRule; w.unshift(`@${a.name}${a.params ? ' ' + a.params : ''}`); }
    else if (p.type === 'rule') w.unshift((p as Rule).selector);
  }
  return w;
}

const declsOf = (c: Container): Record<string, string> => {
  const d: Record<string, string> = {};
  c.each((n) => { if (n.type === 'decl') d[(n as Declaration).prop.toLowerCase()] = (n as Declaration).value; });
  return d;
};

export function parseStylesheet(text: string, opts: { syntax?: Syntax } = {}): Stylesheet {
  const sheet: Stylesheet = { fontFaces: [], featureValues: new Map(), counterStyles: [], declared: [], keyframes: [], textTransforms: [], firstLine: [], emMediaQueries: false, errors: [] };
  let root: Root;
  try {
    root = opts.syntax === 'scss' ? postcssScss.parse(text) : opts.syntax === 'less' ? (postcssLess.parse!(text) as unknown as Root) : postcss.parse(text);
  } catch (e) {
    sheet.errors.push((e as Error).message);
    return sheet;
  }
  root.walkAtRules((a) => {
    const name = a.name.toLowerCase();
    if (name === 'font-face') {
      const d = declsOf(a);
      const family = parseFamilyList(d['font-family'] ?? '')[0];
      if (!family) return;
      const { src, computed } = parseSrc(d.src ?? '');
      let unicodeRange: Range[] = [[0, 0x10ffff]];
      try { if (d['unicode-range']) unicodeRange = parseUnicodeRange(d['unicode-range']); } catch { /* invalid: browsers drop the descriptor */ }
      sheet.fontFaces.push({
        family, src, unicodeRange, computed,
        weight: parseWeightDescriptor(d['font-weight']),
        style: parseStyle(d['font-style']),
        stretch: parseStretchDescriptor(d['font-stretch'] ?? d['font-width']),
        descriptors: Object.fromEntries(Object.entries(d).sort(([x], [y]) => (x < y ? -1 : 1))),
        start: a.source?.start?.offset ?? 0,
        end: a.source?.end?.offset ?? text.length,
        line: a.source?.start?.line ?? 1,
        wrappers: wrappersOf(a),
      });
    } else if (name === 'font-feature-values') {
      for (const fam of parseFamilyList(a.params)) {
        const byType = sheet.featureValues.get(familyKey(fam)) ?? new Map<string, Map<string, number[]>>();
        sheet.featureValues.set(familyKey(fam), byType);
        a.each((block) => {
          if (block.type !== 'atrule') return;
          const t = (block as AtRule).name.toLowerCase();
          const m = byType.get(t) ?? new Map<string, number[]>();
          byType.set(t, m);
          for (const [k, v] of Object.entries(declsOf(block as AtRule))) m.set(k, v.trim().split(/\s+/).map(Number).filter(Number.isFinite));
        });
      }
    } else if (name === 'counter-style') {
      const d = declsOf(a);
      const syms = (s?: string) => (s ? splitTop(s.trim(), ' ').map((x) => unquote(x)) : []);
      sheet.counterStyles.push({
        name: a.params.trim(),
        system: (d.system ?? 'symbolic').trim(),
        symbols: syms(d.symbols),
        additive: d['additive-symbols'] ? splitTop(d['additive-symbols']).flatMap((p) => syms(p).slice(1)) : [],
        prefix: d.prefix !== undefined ? unquote(d.prefix) : undefined,
        suffix: d.suffix !== undefined ? unquote(d.suffix) : undefined,
        pad: d.pad !== undefined ? syms(d.pad).slice(1).join('') : undefined,
        negative: d.negative !== undefined ? syms(d.negative).join('') : undefined,
        fallback: d.fallback?.trim(),
        extends: d.system?.trim().startsWith('extends') ? d.system.trim().split(/\s+/)[1] : undefined,
      });
    } else if (name === 'keyframes' || name === '-webkit-keyframes') {
      const frames: Record<string, string>[] = [];
      a.each((r) => { if (r.type === 'rule') { const d = declsOf(r as Rule); if (Object.keys(d).some((k) => FONT_PROPS.has(k))) frames.push(d); } });
      if (frames.length) sheet.keyframes.push({ name: unquote(a.params.trim()), frames });
    } else if (name === 'media' && /\d(?:\.\d+)?r?em\b/.test(a.params)) sheet.emMediaQueries = true;
  });
  root.walkRules((r) => {
    if (r.parent?.type === 'atrule' && /keyframes$/i.test((r.parent as AtRule).name)) return;
    const d = declsOf(r);
    const tt = d['text-transform']?.toLowerCase();
    if (tt && /full-width|full-size-kana/.test(tt)) {
      for (const s of splitSelector(r.selector)) sheet.textTransforms.push({ selector: s.base, value: tt.includes('full-width') ? 'full-width' : 'full-size-kana' });
    }
    const fontDecls = Object.fromEntries(Object.entries(d).filter(([k]) => FONT_PROPS.has(k) || k === 'animation' || k === 'animation-name'));
    if (!Object.keys(fontDecls).length) return;
    const selectors = splitSelector(r.selector);
    for (const s of selectors) if (s.pseudo === '::first-line' && Object.keys(fontDecls).some((k) => k.startsWith('font'))) sheet.firstLine.push(s.base);
    sheet.declared.push({ selectors, decls: fontDecls, wrappers: wrappersOf(r) });
  });
  return sheet;
}

/** Extract `<style>` blocks from HTML-like files (.html, .vue, .svelte, .astro), with their offsets. */
export function styleBlocks(source: string): { text: string; offset: number; syntax: Syntax }[] {
  const out: { text: string; offset: number; syntax: Syntax }[] = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(source));) {
    const lang = m[1]!.match(/\blang\s*=\s*["']?(\w+)/i)?.[1]?.toLowerCase();
    const syntax: Syntax = lang === 'scss' || lang === 'sass' ? 'scss' : lang === 'less' ? 'less' : 'css';
    if (lang === 'sass' || lang === 'stylus' || lang === 'styl') continue;
    out.push({ text: m[2]!, offset: m.index + m[0].indexOf('>') + 1, syntax });
  }
  return out;
}
