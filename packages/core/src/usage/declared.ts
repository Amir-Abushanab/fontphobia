// Applying declared font values (from :hover rules, media queries, keyframes) to a computed style
// row, so the builder can treat them as virtual runs (§7.5).
import { STYLE_PROPS, type StyleRow } from './capture.ts';
import { relativeWeight, splitTop, STRETCH_KW } from '../css/values.ts';

const idx = Object.fromEntries(STYLE_PROPS.map((p, i) => [p, i])) as Record<(typeof STYLE_PROPS)[number], number>;

const SIMPLE = [
  'font-family',
  'font-style',
  'font-variation-settings',
  'font-feature-settings',
  'font-variant-ligatures',
  'font-variant-caps',
  'font-variant-numeric',
  'font-variant-east-asian',
  'font-variant-position',
  'font-variant-alternates',
  'font-kerning',
  'font-optical-sizing',
  'letter-spacing',
] as const;

const CAPS = new Set(['small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps']);
const NUMERIC = new Set([
  'lining-nums',
  'oldstyle-nums',
  'proportional-nums',
  'tabular-nums',
  'diagonal-fractions',
  'stacked-fractions',
  'ordinal',
  'slashed-zero',
]);
const LIGS = new Set([
  'common-ligatures',
  'no-common-ligatures',
  'discretionary-ligatures',
  'no-discretionary-ligatures',
  'historical-ligatures',
  'no-historical-ligatures',
  'contextual',
  'no-contextual',
]);
const SYSTEM_FONTS = new Set(['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']);

function weightOf(v: string, base: number): number | undefined {
  const s = v.trim().toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  if (s === 'bolder' || s === 'lighter') return relativeWeight(s, base);
  const n = Number(s);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : undefined;
}

function stretchOf(v: string): string | undefined {
  const s = v.trim().toLowerCase();
  if (STRETCH_KW[s] !== undefined) return `${STRETCH_KW[s]}%`;
  return /^[\d.]+%$/.test(s) ? s : undefined;
}

const unresolvable = (v: string) => /var\(|env\(|attr\(|^\s*(inherit|initial|unset|revert|revert-layer)\s*$/i.test(v);

/** Returns a new row with the declarations applied; declarations we can't resolve statically are skipped. */
export function applyDeclared(row: StyleRow, decls: Record<string, string>): StyleRow {
  const out = [...row];
  const set = (p: (typeof STYLE_PROPS)[number], v: string) => {
    out[idx[p]] = v;
  };
  const base = Number(row[idx['font-weight']]) || 400;
  if (decls.font && !unresolvable(decls.font)) applyFontShorthand(out, decls.font, base);
  if (decls['font-variant'] && !unresolvable(decls['font-variant'])) {
    const w = splitTop(decls['font-variant'], ' ');
    if (w[0] === 'normal' || w[0] === 'none')
      for (const p of [
        'font-variant-ligatures',
        'font-variant-caps',
        'font-variant-numeric',
        'font-variant-east-asian',
        'font-variant-position',
        'font-variant-alternates',
      ] as const)
        set(p, w[0] === 'none' && p === 'font-variant-ligatures' ? 'none' : 'normal');
    const caps = w.filter((x) => CAPS.has(x)),
      num = w.filter((x) => NUMERIC.has(x)),
      lig = w.filter((x) => LIGS.has(x));
    if (caps.length) set('font-variant-caps', caps.join(' '));
    if (num.length) set('font-variant-numeric', num.join(' '));
    if (lig.length) set('font-variant-ligatures', lig.join(' '));
    if (w.includes('sub') || w.includes('super')) set('font-variant-position', w.includes('sub') ? 'sub' : 'super');
  }
  for (const p of SIMPLE) {
    const v = decls[p];
    if (v !== undefined && !unresolvable(v)) set(p, v.trim());
  }
  const fw = decls['font-weight'];
  if (fw && !unresolvable(fw)) {
    const w = weightOf(fw, base);
    if (w !== undefined) set('font-weight', String(w));
  }
  const fs = decls['font-stretch'] ?? decls['font-width'];
  if (fs && !unresolvable(fs)) {
    const s = stretchOf(fs);
    if (s) set('font-stretch', s);
  }
  const size = decls['font-size'];
  if (size && /^\s*[\d.]+px\s*$/i.test(size)) set('font-size', size.trim());
  return out;
}

function applyFontShorthand(out: StyleRow, value: string, base: number) {
  const v = value.trim();
  if (SYSTEM_FONTS.has(v.toLowerCase())) return;
  const tokens = splitTop(v, ' ');
  const sizeAt = tokens.findIndex((t) =>
    /^([\d.]+(px|r?em|%|pt|vw|vh|ch|ex|cap|lh|rlh|cqw|cqi|q|mm|cm|in|pc)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|calc\(.*|clamp\(.*|min\(.*|max\(.*)(\/.*)?$/i.test(
      t,
    ),
  );
  if (sizeAt < 0) return;
  const pre = tokens.slice(0, sizeAt);
  const family = tokens.slice(sizeAt + 1).join(' ');
  const reset: [(typeof STYLE_PROPS)[number], string][] = [
    ['font-style', 'normal'],
    ['font-weight', '400'],
    ['font-stretch', '100%'],
    ['font-variant-caps', 'normal'],
    ['font-variant-ligatures', 'normal'],
    ['font-variant-numeric', 'normal'],
    ['font-variant-east-asian', 'normal'],
    ['font-variant-position', 'normal'],
    ['font-variant-alternates', 'normal'],
    ['font-feature-settings', 'normal'],
    ['font-variation-settings', 'normal'],
    ['font-kerning', 'auto'],
    ['font-optical-sizing', 'auto'],
  ];
  for (const [p, d] of reset) out[idx[p]] = d;
  for (let i = 0; i < pre.length; i++) {
    const t = pre[i]!.toLowerCase();
    if (t === 'italic') out[idx['font-style']] = 'italic';
    else if (t === 'oblique') {
      const a = pre[i + 1]?.match(/^-?[\d.]+deg$/) ? pre[++i]! : '14deg';
      out[idx['font-style']] = `oblique ${a}`;
    } else if (t === 'small-caps') out[idx['font-variant-caps']] = 'small-caps';
    else if (stretchOf(t) && STRETCH_KW[t] !== undefined) out[idx['font-stretch']] = stretchOf(t)!;
    else {
      const w = weightOf(t, base);
      if (w !== undefined && t !== 'normal') out[idx['font-weight']] = String(w);
    }
  }
  const size = tokens[sizeAt]!.split('/')[0]!;
  if (/^[\d.]+px$/i.test(size)) out[idx['font-size']] = size;
  if (family) out[idx['font-family']] = family;
}

/** Weights an animation passes through between two values, in steps of 100 (static faces in between load too). */
export function weightSteps(a: number, b: number): number[] {
  const lo = Math.min(a, b),
    hi = Math.max(a, b);
  const out = [lo];
  for (let w = Math.ceil((lo + 1) / 100) * 100; w < hi; w += 100) out.push(w);
  if (hi !== lo) out.push(hi);
  return out;
}
