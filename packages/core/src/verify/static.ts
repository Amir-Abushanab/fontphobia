// `verify`, the deterministic layers (§10.1–10.2): no browser, any OS.
//  - Font level: every output the manifest lists is on disk with its bytes, decodes, passes the §9.5
//    checks again, and the marked CSS block loads exactly those files with the original descriptors.
//  - Shaping equivalence: every stored word in every style context shapes the same with the outputs,
//    split by unicode-range the way Chrome splits text, as with the source font.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codePointsOf, formatUnicodeRange, parseUnicodeRange } from '../css/unicode-range.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import { unquote } from '../css/values.ts';
import { loadFont } from '../font/hb.ts';
import { toSfnt, woff2Decompress } from '../font/io.ts';
import { parseFvar } from '../font/tables.ts';
import { wordsOf, type UsageFileJson } from '../plan/planner.ts';
import { checkShaping, type OutputFile } from '../shape/equivalence.ts';
import { checkMetrics, validateOutput } from '../subset/subset.ts';
import { findBlock } from '../build/css.ts';
import type { Manifest, ManifestEntry } from '../build/manifest.ts';

export type VerifyFindingKind = 'output' | 'css' | 'coverage' | 'shaping' | 'source';

export interface VerifyFinding {
  id: string;
  kind: VerifyFindingKind;
  /** A regression fails verify; a warning doesn't. */
  severity: 'regression' | 'warning';
  message: string;
}

export interface ShapingResult {
  id: string;
  words: number;
  cases: number;
  identical: number;
  rounding: number;
  regressions: number;
  /** Up to 20 failing cases. */
  examples: { text: string; features: string[]; variations?: Record<string, number>; reason: string }[];
  /** limit-axes: the worst outline and advance changes (font units), and the summed width change per case. */
  maxPointDelta?: number;
  maxAdvanceDelta?: number;
  maxWidthDelta?: number;
}

export interface StaticVerify {
  findings: VerifyFinding[];
  shaping: ShapingResult[];
  /** Outputs decoded, by repo path (the browser layer reuses them for its FontFace check). */
  outputs: Map<string, { entry: string; woff2: Uint8Array }>;
  ok: boolean;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const list = (cps: number[], n = 8) => cps.slice(0, n).map(hex).join(' ') + (cps.length > n ? ` and ${cps.length - n} more` : '');
const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();

/** The @font-face rules in the entry's marked block must be the original rule, with only src, unicode-range and the planned descriptors changed. */
function checkCss(root: string, e: ManifestEntry, add: (kind: VerifyFindingKind, severity: VerifyFinding['severity'], m: string) => void) {
  const file = join(root, e.stylesheet);
  if (!existsSync(file)) return add('css', 'regression', `${e.stylesheet} is gone`);
  const text = readFileSync(file, 'utf8');
  const span = findBlock(text, e.id);
  if (!span) return add('css', 'regression', `the marked block is gone from ${e.stylesheet}; run \`fontphobia build --write\` or \`fontphobia revert\``);
  const rules = parseStylesheet(text.slice(span.start, span.end)).fontFaces;
  const orig = parseStylesheet(e.declaration).fontFaces[0];
  if (!orig) return add('css', 'regression', `the manifest's original declaration doesn't parse`);
  if (rules.length !== e.outputs.length) add('css', 'regression', `${e.stylesheet}: the block has ${rules.length} @font-face rule(s), the manifest lists ${e.outputs.length} output(s)`);
  const changed = new Set(['src', 'unicode-range', ...Object.keys(e.plan.descriptors ?? {})]);
  // Rules run rest, extended, core: the core rule must be last (WebKit's primary font, M5 notes).
  const firstUrl = (r: (typeof rules)[number]) => r.src.find((s) => s.url)?.url;
  if (rules.length && e.outputs.some((o) => o.role === 'core') && firstUrl(rules[rules.length - 1]!) !== e.outputs.find((o) => o.role === 'core')!.url) add('css', 'regression', `the core rule isn't the block's last rule: WebKit would take decoration and emphasis metrics from another file`);
  for (const o of e.outputs) {
    const r = rules.find((x) => firstUrl(x) === o.url);
    if (!r) { add('css', 'regression', `no rule in the block loads ${o.url} (${o.role})`); continue; }
    const range = r.descriptors['unicode-range'];
    if (!range || formatUnicodeRange(parseUnicodeRange(range)) !== formatUnicodeRange(parseUnicodeRange(o.unicodeRange))) add('css', 'regression', `${o.role} rule's unicode-range isn't the file's cmap`);
    if (norm(unquote(r.family)) !== norm(unquote(orig.family))) add('css', 'regression', `${o.role} rule has font-family ${JSON.stringify(r.family)}, the original is ${JSON.stringify(orig.family)}: its characters fall back`);
    for (const k of new Set([...Object.keys(orig.descriptors), ...Object.keys(r.descriptors)])) {
      if (changed.has(k) || k === 'font-family') continue;
      if (norm(orig.descriptors[k] ?? '') !== norm(r.descriptors[k] ?? '')) add('css', 'regression', `${o.role} rule: ${k} is ${r.descriptors[k] ?? 'unset'}, the original is ${orig.descriptors[k] ?? 'unset'}`);
    }
    for (const [k, v] of Object.entries(e.plan.descriptors ?? {})) if (norm(r.descriptors[k] ?? '') !== norm(v)) add('css', 'regression', `${o.role} rule: ${k} should be ${v} (limit-axes)`);
  }
}

export async function verifyStatic(root: string, usage: UsageFileJson, manifest: Manifest): Promise<StaticVerify> {
  const findings: VerifyFinding[] = [];
  const shaping: ShapingResult[] = [];
  const outputs = new Map<string, { entry: string; woff2: Uint8Array }>();
  for (const e of Object.values(manifest.entries).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const add = (kind: VerifyFindingKind, severity: VerifyFinding['severity'], message: string) => findings.push({ id: e.id, kind, severity, message });
    const srcPath = join(root, e.source.file);
    if (!existsSync(srcPath)) { add('source', 'regression', `the source font ${e.source.file} is gone; verify needs it as the reference`); continue; }
    const srcBytes = new Uint8Array(readFileSync(srcPath));
    if (sha(srcBytes) !== e.source.sha256) add('source', 'warning', `${e.source.file} changed since the build; run \`fontphobia\` again to rebuild from it`);
    const source = await toSfnt(srcBytes);
    const pinned = Object.values(e.plan.axes ?? {}).some((v) => typeof v === 'number');

    // §10.1: each output as the manifest records it, revalidated.
    const files: (OutputFile & { role: string })[] = [];
    for (const o of e.outputs) {
      const p = join(root, o.file);
      if (!existsSync(p)) { add('output', 'regression', `${o.file} is missing`); continue; }
      const woff2 = new Uint8Array(readFileSync(p));
      if (sha(woff2) !== o.sha256) { add('output', 'regression', `${o.file} changed since the build (sha256 differs from the manifest)`); continue; }
      outputs.set(o.file, { entry: e.id, woff2 });
      let decoded: Uint8Array;
      try { decoded = await woff2Decompress(woff2); } catch (x) { add('output', 'regression', `${o.file} doesn't decode: ${(x as Error).message}`); continue; }
      try {
        const cmap = [...codePointsOf(parseUnicodeRange(o.unicodeRange)), ...(o.hintRefs ? codePointsOf(parseUnicodeRange(o.hintRefs)) : [])];
        validateOutput(source, decoded, { unicodes: cmap, axes: e.plan.axes, rename: e.plan.rename });
        checkMetrics(source, decoded, pinned);
      } catch (x) { add('output', 'regression', `${o.file}: ${(x as Error).message}`); }
      files.push({ role: o.role, sfnt: decoded, ranges: parseUnicodeRange(o.unicodeRange) });
    }
    // The files must not overlap (Chrome would pick the first; the plan never makes overlaps).
    const seen = new Map<number, string>();
    for (const o of e.outputs) for (const c of codePointsOf(parseUnicodeRange(o.unicodeRange))) {
      const prev = seen.get(c);
      if (prev) { add('output', 'regression', `${hex(c)} is in both ${prev} and ${o.role}`); break; }
      seen.set(c, o.role);
    }
    checkCss(root, e, add);

    const face = usage.faces[e.id];
    if (!face) { add('coverage', 'warning', `usage.json has no face ${e.id}; shaping wasn't checked (rerun audit)`); continue; }
    // Every character the face drew (and the source has) is in some output.
    const cmap = new Set(loadFont(source).face.collectUnicodes());
    const used = [...codePointsOf(parseUnicodeRange(face.chars))].filter((c) => cmap.has(c));
    const missing = used.filter((c) => !seen.has(c));
    if (missing.length) add('coverage', 'regression', `used character(s) ${list(missing)} aren't in any output: they render in a fallback font`);

    // §10.2: shaping equivalence over every stored word.
    if (files.length !== e.outputs.length) continue;
    const words = wordsOf(face, new Set(used), parseFvar(source)?.axes ?? []);
    const cases = words.flatMap((w) => w.cases);
    const r: ShapingResult = { id: e.id, words: words.length, cases: cases.length, identical: 0, rounding: 0, regressions: 0, examples: [] };
    const limit = e.plan.optIns.includes('limit-axes');
    const order = ['core', 'ext', 'rest'];
    const sorted = [...files].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    for (const c of checkShaping(source, sorted, cases)) {
      const v = c.verdict;
      if (v.kind === 'identical') { r.identical++; continue; }
      if (v.kind === 'rounding' && limit) {
        r.rounding++;
        r.maxPointDelta = Math.max(r.maxPointDelta ?? 0, v.maxPointDelta);
        r.maxAdvanceDelta = Math.max(r.maxAdvanceDelta ?? 0, v.maxAdvanceDelta);
        r.maxWidthDelta = Math.max(r.maxWidthDelta ?? 0, Math.abs(v.widthDelta));
        continue;
      }
      r.regressions++;
      const reason = v.kind === 'rounding' ? `outlines or advances moved (up to ${v.maxPointDelta.toFixed(1)} / ${v.maxAdvanceDelta} units) without limit-axes` : v.reason;
      if (r.examples.length < 20) r.examples.push({ text: c.case.text, features: c.case.features ?? [], variations: c.case.variations, reason });
    }
    shaping.push(r);
    if (r.regressions) {
      const ex = r.examples[0]!;
      const ctx = [ex.features.join(','), Object.entries(ex.variations ?? {}).map(([t, v]) => `${t}=${v}`).join(',')].filter(Boolean).join(' ');
      add('shaping', 'regression', `${r.regressions} of ${r.cases} shaping case(s) differ from the source; e.g. ${JSON.stringify(ex.text)}${ctx ? ` (${ctx})` : ''}: ${ex.reason}`);
    }
  }
  return { findings, shaping, outputs, ok: !findings.some((f) => f.severity === 'regression') };
}
