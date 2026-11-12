import { describe, expect, it } from 'vitest';
import {
  featuresOf,
  formatSettings,
  parseFamilyList,
  parseFeatureSettings,
  parseStretchDescriptor,
  parseStyle,
  parseStylesheet,
  parseVariationSettings,
  parseWeightDescriptor,
  relativeWeight,
  splitSelector,
  styleBlocks,
  formatUnicodeRange,
} from '../src/index.ts';

describe('values', () => {
  it('parses family lists', () => {
    expect(parseFamilyList(`"Inter Variable", Inter,  Helvetica   Neue , 'A\\,B', sans-serif`)).toEqual([
      'Inter Variable',
      'Inter',
      'Helvetica Neue',
      'A,B',
      'sans-serif',
    ]);
  });
  it('parses descriptors', () => {
    expect(parseWeightDescriptor('100 900')).toEqual([100, 900]);
    expect(parseWeightDescriptor('bold')).toEqual([700, 700]);
    expect(parseWeightDescriptor(undefined)).toEqual([400, 400]);
    expect(parseStretchDescriptor('condensed 125%')).toEqual([75, 125]);
    expect(parseStyle('oblique 0deg 20deg')).toEqual({ kind: 'oblique', min: 0, max: 20 });
    expect(parseStyle('oblique')).toEqual({ kind: 'oblique', min: 14, max: 14 });
    expect(parseStyle('italic')).toEqual({ kind: 'italic' });
  });
  it('parses feature and variation settings', () => {
    expect(parseFeatureSettings(`"tnum", "ss01" 2, 'liga' off, "kern" on`)).toEqual([
      ['tnum', 1],
      ['ss01', 2],
      ['liga', 0],
      ['kern', 1],
    ]);
    expect(parseFeatureSettings('normal')).toEqual([]);
    expect(parseVariationSettings(`"wght" 650, 'opsz' 32.5`)).toEqual([
      ['wght', 650],
      ['opsz', 32.5],
    ]);
  });
  it('maps font-variant-* to tags (§7.5)', () => {
    const fv = new Map([
      [
        'inter',
        new Map([
          [
            'styleset',
            new Map([
              ['open-digits', [1]],
              ['alts', [3, 5]],
            ]),
          ],
          ['character-variant', new Map([['g', [11, 2]]])],
        ]),
      ],
    ]);
    const m = featuresOf(
      {
        fontVariantCaps: 'all-small-caps',
        fontVariantNumeric: 'tabular-nums slashed-zero diagonal-fractions',
        fontVariantLigatures: 'no-common-ligatures discretionary-ligatures',
        fontVariantPosition: 'super',
        fontVariantAlternates: 'styleset(open-digits, alts) character-variant(g)',
        fontVariantEastAsian: 'jis04 full-width',
        fontFeatureSettings: '"zero" 0',
      },
      'Inter',
      fv,
    );
    expect(formatSettings(m)).toBe(
      'c2sc=1,clig=0,cv11=2,dlig=1,frac=1,fwid=1,jp04=1,liga=0,smcp=1,ss01=1,ss03=1,ss05=1,sups=1,tnum=1,zero=0',
    );
  });
  it('turns off optional ligatures with letter-spacing, and kerning with font-kerning: none', () => {
    expect(formatSettings(featuresOf({ letterSpacing: '0.1em', fontKerning: 'none' }, 'X'))).toBe(
      'calt=0,clig=0,dlig=0,hlig=0,kern=0,liga=0',
    );
    expect(formatSettings(featuresOf({ letterSpacing: 'normal' }, 'X'))).toBe('');
    expect(formatSettings(featuresOf({ letterSpacing: '0px' }, 'X'))).toBe('');
  });
  it('resolves relative weights', () => {
    expect([100, 400, 600, 900].map((w) => relativeWeight('bolder', w))).toEqual([400, 700, 900, 900]);
    expect([100, 400, 600, 900].map((w) => relativeWeight('lighter', w))).toEqual([100, 100, 400, 700]);
  });
});

describe('stylesheet', () => {
  const css = `
    @layer base { @media (min-width: 40em) {
      @font-face { font-family: "Inter"; src: local("Inter"), url(./a.woff2) format("woff2-variations") tech(variations), url('b.woff') format('woff'); font-weight: 100 900; unicode-range: U+0000-00FF, U+0131; font-display: swap; }
    } }
    @font-face { font-family: Mono; src: url(data:font/woff2;base64,AAAA); }
    @font-feature-values Inter, "Other" { @styleset { nice: 2; } @character-variant { g: 11 2; } }
    @counter-style thumbs { system: cyclic; symbols: "👍" '👎'; suffix: " "; }
    @keyframes pulse { from { font-weight: 300; } 50% { color: red } to { font-weight: 600; } }
    .a:hover, .b:focus-visible::before { font-weight: 800; }
    .c { color: red; }
    @media print { .d { font-family: serif; } }
    .fw { text-transform: full-width; }
    p::first-line { font-family: Deja; }
    @media (max-width: 30rem) { .x { color: blue } }
  `;
  const s = parseStylesheet(css);
  it('parses @font-face with wrappers, src and ranges', () => {
    expect(s.fontFaces).toHaveLength(2);
    const f = s.fontFaces[0]!;
    expect(f.family).toBe('Inter');
    expect(f.src).toEqual([
      { local: 'Inter' },
      { url: './a.woff2', format: 'woff2-variations', tech: 'variations' },
      { url: 'b.woff', format: 'woff' },
    ]);
    expect(f.weight).toEqual([100, 900]);
    expect(formatUnicodeRange(f.unicodeRange)).toBe('U+0-FF, U+131');
    expect(f.wrappers).toEqual(['@layer base', '@media (min-width: 40em)']);
    expect(css.slice(f.start, f.end)).toMatch(/^@font-face \{[\s\S]*\}$/);
    expect(s.fontFaces[1]!.src[0]!.url).toBe('data:font/woff2;base64,AAAA');
    expect(s.fontFaces[1]!.unicodeRange).toEqual([[0, 0x10ffff]]);
  });
  it('parses @font-feature-values and @counter-style', () => {
    expect(s.featureValues.get('other')?.get('styleset')?.get('nice')).toEqual([2]);
    expect(s.featureValues.get('inter')?.get('character-variant')?.get('g')).toEqual([11, 2]);
    expect(s.counterStyles[0]).toMatchObject({ name: 'thumbs', system: 'cyclic', symbols: ['👍', '👎'], suffix: ' ' });
  });
  it('collects declared values with states stripped (§7.5)', () => {
    expect(s.keyframes).toEqual([{ name: 'pulse', frames: [{ 'font-weight': '300' }, { 'font-weight': '600' }] }]);
    const hover = s.declared.find((d) => d.decls['font-weight'] === '800')!;
    expect(hover.selectors).toEqual([
      { base: '.a', pseudo: undefined, states: [':hover'] },
      { base: '.b', pseudo: '::before', states: [':focus-visible'] },
    ]);
    expect(s.declared.find((d) => d.decls['font-family'] === 'serif')!.wrappers).toEqual(['@media print']);
    expect(s.declared.some((d) => d.decls.color)).toBe(false);
    expect(s.textTransforms).toEqual([{ selector: '.fw', value: 'full-width' }]);
    expect(s.firstLine).toEqual(['p']);
    expect(s.emMediaQueries).toBe(true);
  });
  it('splits selectors', () => {
    expect(splitSelector('a:hover > span, :focus')).toEqual([
      { base: 'a > span', pseudo: undefined, states: [':hover'] },
      { base: '*', pseudo: undefined, states: [':focus'] },
    ]);
    expect(splitSelector('li::marker')).toEqual([{ base: 'li', pseudo: '::marker', states: [] }]);
    expect(splitSelector('input::placeholder')).toEqual([{ base: 'input', pseudo: '::placeholder', states: [] }]);
  });
  it('reads Sass and Less', () => {
    expect(
      parseStylesheet(
        '$w: 400; @font-face { font-family: S; src: url("#{$base}/s.woff2"); font-weight: $w; } .a { .b { c: d } }',
        { syntax: 'scss' },
      ).fontFaces[0]!.computed,
    ).toBe(true);
    expect(
      parseStylesheet('@w: 400; @font-face { font-family: L; src: url("l.woff2"); }', { syntax: 'less' }).fontFaces[0]!
        .family,
    ).toBe('L');
  });
  it('finds <style> blocks in components', () => {
    const vue = `<template><p/></template>\n<style scoped>\n@font-face { font-family: V; src: url(v.woff2) }\n</style>\n<style lang="sass">\n.x\n  color: red\n</style>`;
    const b = styleBlocks(vue);
    expect(b).toHaveLength(1);
    expect(vue.slice(b[0]!.offset, b[0]!.offset + 12)).toBe('\n@font-face ');
  });
});

describe('sameFaceDescriptors', () => {
  it('tells faces that share one variable file apart, and reads unicode-range wildcards', async () => {
    const { sameFaceDescriptors } = await import('../src/css/face-match.ts');
    expect(sameFaceDescriptors({ 'font-weight': '400' }, { 'font-weight': '700' })).toBe(false);
    expect(sameFaceDescriptors({ 'font-weight': '400', 'font-style': 'normal' }, { 'font-weight': '400' })).toBe(true);
    expect(sameFaceDescriptors({ 'font-weight': '400', 'font-style': 'italic' }, { 'font-weight': '400' })).toBe(false);
    expect(sameFaceDescriptors({ 'unicode-range': 'U+0-FF, U+131' }, { 'unicode-range': 'U+??,U+131' })).toBe(true);
    expect(sameFaceDescriptors({ 'unicode-range': 'U+0-FF' }, { 'unicode-range': 'U+100-17F' })).toBe(false);
  });
});
