// What `build --write` records about the CSS around its blocks, so `check` (§12) reports only what
// changed since: the other @font-face rules, and the features and axis values the CSS asks for.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CssSource } from '../adapters/css.ts';
import { parseStylesheet, styleBlocks, type Syntax } from '../css/stylesheet.ts';
import { familyKey, featuresOf, parseFamilyList, parseVariationSettings, type FeatureValues } from '../css/values.ts';
import { listFiles } from '../project/detect.ts';
import type { Edit } from './edits.ts';
import type { Manifest } from './manifest.ts';

const sha = (b: string) => createHash('sha256').update(b).digest('hex');

/** Hash of an @font-face's text, ignoring whitespace. */
export const ruleHash = (text: string): string => sha(text.replace(/\s+/g, ' ').trim());

/** @font-face rules that stay outside fontphobia's blocks after this build, by file and family. */
export function otherFaces(root: string, css: CssSource[], edits: Edit[] = []): NonNullable<Manifest['others']> {
  const texts = new Map<string, string>();
  const text = (f: string) => { let t = texts.get(f); if (t === undefined) { t = readFileSync(join(root, f), 'utf8'); texts.set(f, t); } return t; };
  return css.filter((s) => !s.manual).filter((s) => {
    if (edits.some((e) => e.file === s.file && e.start <= s.rule.start && s.rule.end <= e.end)) return false; // being replaced by a block
    const t = text(s.file);
    const b = t.lastIndexOf('/* fontphobia:begin ', s.rule.start), e = t.lastIndexOf('/* fontphobia:end ', s.rule.start);
    return !(b >= 0 && b > e); // inside a block
  }).map((s) => ({ file: s.file, family: s.rule.family, sha256: ruleHash(text(s.file).slice(s.rule.start, s.rule.end)) }))
    .toSorted((a, b) => (a.file + a.family + a.sha256 < b.file + b.family + b.sha256 ? -1 : 1));
}

export interface Demand { file: string; /** familyKey()s, or undefined: whatever family is inherited. */ families?: string[]; features: [string, number][]; axes: [string, number][] }

const SKIP = new Set(['node_modules', '.git', '.fontphobia', 'dist', 'build', 'out', '_site', '.output', '.next', '.nuxt', '.svelte-kit', '.astro', '.vercel', '.netlify', '.turbo', '.cache', 'coverage', '.angular', '.wrangler', '.docusaurus', '.tanstack', '.nitro']);
const STYLE_EXT = /\.(css|scss|less|pcss|postcss|html?|vue|svelte|astro)$/i;

/** Every style rule's font features and axis values (font-weight, font-variation-settings), with its families. */
export function cssDemands(root: string): Demand[] {
  const files = listFiles(root, (r) => STYLE_EXT.test(r), { skip: (rel, n) => SKIP.has(n) || (n.startsWith('.') && n !== '.vitepress') || rel.endsWith('.vitepress/dist') });
  const fv: FeatureValues = new Map();
  const rules: { file: string; decls: Record<string, string>; families?: string[] }[] = [];
  for (const file of files) {
    let text: string;
    try { if (statSync(join(root, file)).size > 2_000_000) continue; text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const chunks: { text: string; syntax: Syntax }[] = /\.(html?|vue|svelte|astro)$/i.test(file) ? styleBlocks(text) : [{ text, syntax: /\.scss$/i.test(file) ? 'scss' : /\.less$/i.test(file) ? 'less' : 'css' }];
    for (const c of chunks) {
      const sheet = parseStylesheet(c.text, { syntax: c.syntax });
      for (const [k, v] of sheet.featureValues) fv.set(k, v);
      for (const r of sheet.declared) rules.push({ file, decls: r.decls, families: r.decls['font-family'] ? parseFamilyList(r.decls['font-family']).map(familyKey) : undefined });
    }
  }
  return rules.map((r) => {
    const d = r.decls;
    const features = [...featuresOf({
      fontVariantLigatures: d['font-variant-ligatures'], fontVariantCaps: d['font-variant-caps'], fontVariantNumeric: d['font-variant-numeric'],
      fontVariantEastAsian: d['font-variant-east-asian'], fontVariantPosition: d['font-variant-position'], fontVariantAlternates: d['font-variant-alternates'],
      fontFeatureSettings: d['font-feature-settings'],
    }, r.families?.[0], fv)].filter(([, v]) => v !== 0);
    const axes: [string, number][] = parseVariationSettings(d['font-variation-settings']);
    const w = d['font-weight']?.trim();
    if (w && /^\d+(\.\d+)?$/.test(w)) axes.push(['wght', Number(w)]); else if (w === 'bold') axes.push(['wght', 700]);
    return { file: r.file, families: r.families, features, axes };
  }).filter((x) => x.features.length || x.axes.length);
}

const keysOf = (d: Demand) => (d.families ?? ['*']).flatMap((f) => [...d.features.map(([t]) => `${f}|feature|${t}`), ...d.axes.map(([t, v]) => `${f}|axis|${t}=${v}`)]);
export const demandKeys = (ds: Demand[]): string[] => [...new Set(ds.flatMap(keysOf))].toSorted();
/** Demands with at least one key the build didn't see. */
export const newDemands = (ds: Demand[], seen: string[] | undefined): Demand[] => {
  if (!seen) return ds;
  const s = new Set(seen);
  return ds.map((d) => {
    const fam = d.families ?? ['*'];
    const unseen = (k: (f: string) => string) => fam.some((f) => !s.has(k(f)));
    return { ...d, features: d.features.filter(([t]) => unseen((f) => `${f}|feature|${t}`)), axes: d.axes.filter(([t, v]) => unseen((f) => `${f}|axis|${t}=${v}`)) };
  }).filter((d) => d.features.length || d.axes.length);
};
