// The planner (§8): usage + source font + config → one FacePlan per face, with every opt-in's
// measured saving. Deterministic: no browser, no network, no clock. It subsets in memory to repair
// cross-file shaping (§8.3) and to measure sizes; `build --write` (M4) writes what it planned.
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  codePointsOf,
  formatUnicodeRange,
  inRanges,
  parseUnicodeRange,
  rangesFromCodePoints,
  type Range,
} from '../css/unicode-range.ts';
import { parseStretchDescriptor, parseWeightDescriptor, relativeWeight } from '../css/values.ts';
import { loadFont } from '../font/hb.ts';
import { compressedSize, toSfnt } from '../font/io.ts';
import { readSfnt } from '../font/sfnt.ts';
import { glyfInstructionBytes, parseFvar, type Axis } from '../font/tables.ts';
import { checkShaping, type ShapeCase } from '../shape/equivalence.ts';
import { hbSubset, subsetFont, type AxisSetting, type SubsetOptions } from '../subset/subset.ts';
import { chooseCore } from './core.ts';
import { detectLicense, licenseRefusal, renameFor, type License } from './license.ts';
import { localeChars } from './locale.ts';
import { cmapAliases, hintRefs, macosReferenceGlyphs, reverseCmap } from './hintrefs.ts';

// ─── Input: usage.json as written by `audit` (§7.6) ─────────────────────────────────────────────

export interface AxesJson {
  weight?: number[];
  stretch?: number[];
  style?: string[];
  size?: number[];
  axes?: Record<string, number[]>;
}
export interface UsageFaceJson {
  family: string;
  descriptors: Record<string, string>;
  source: { adapter: string; file?: string; line?: number; fontFile?: string; sha256?: string; note?: string };
  /** The stylesheet that declared the face (Google's CSS URL for google-fonts). */
  sheet?: string;
  files: { url: string; sha256?: string; bytes?: number }[];
  chars: string;
  count: number;
  inserted: Record<string, string>;
  contexts: { features: string; axes: Record<string, [number, number]>; words: string[] }[];
  rendered: AxesJson;
  declared: AxesJson;
  features: string[];
  editable?: boolean;
  local?: boolean;
  wordsTruncated?: boolean;
  locales: string[];
  pages: string[];
}
export interface UsageFileJson {
  version: number;
  meta: {
    fontphobia: string;
    harfbuzz: string;
    chrome: string;
    framework: string;
    mode: string;
    viewports: number[];
    fontSizes: number[];
  };
  faces: Record<string, UsageFaceJson>;
  pages: Record<
    string,
    {
      private?: boolean;
      faces: Record<string, string>;
      bytes: number;
      fonts: { url: string; status: number; bytes: number; sha256?: string; faces: string[] }[];
    }
  >;
}

export interface PlanConfig {
  /**
   * Which of the characters the site uses go in core (§8.2). 'auto' (default): the ones that make
   * the face's pages download the least in total, measured (plan/core.ts). A number from 0 to 1:
   * the ones at least this share of the face's pages use.
   */
  coreThreshold?: number | 'auto';
  /** The third, lazy "rest" file (default true). */
  remainder?: boolean;
  /** Opt-ins: limit-axes, drop-hinting, split-shaping. */
  allow?: string[];
  locales?: string[];
  rename?: Record<string, string>;
  licenses?: { allow?: string[] };
  /** Tests only: a deliberate bug that `verify` must catch (§15, mutation tests). */
  mutation?: Mutation;
}

/** The verifier's mutation tests (§15): each must make `verify` fail with the right cause. */
export type Mutation = { face: string } & (
  | { kind: 'drop-char'; cp: number }
  | { kind: 'drop-feature'; tag: string }
  | { kind: 'pin-axis'; tag: string; value: number }
  | { kind: 'ext-family'; family: string }
  | { kind: 'mark-out-of-core' }
);

export interface SourceFont {
  /** Font bytes as found in the repo (any container). */
  bytes: Uint8Array;
  /** Repo-relative path. */
  file: string;
  /** The license, when the caller looked for files next to the font (§11). Read from the name table otherwise. */
  license?: License;
}

// ─── Output ─────────────────────────────────────────────────────────────────────────────────────

export type Role = 'core' | 'ext' | 'rest';
export const OPT_INS = ['limit-axes', 'drop-hinting', 'split-shaping', 'drop-hint-refs'] as const;
export type OptInId = (typeof OPT_INS)[number];

export interface PlannedFile {
  role: Role;
  /** unicode-range, from the output's real cmap (§9.6). */
  unicodeRange: string;
  count: number;
  bytes: number;
  sha256: string;
  /** `<source-name>.<role>.<hash8>.woff2` (§9.7). */
  name: string;
  /** Characters in the file's cmap but not its unicode-range: the auto-hinter's references (plan/hintrefs.ts). */
  hintRefs?: string;
}

export interface OptIn {
  id: OptInId;
  /** Bytes saved on the core and extended files (split-shaping: on core, which every page using the face loads). */
  saving: number;
  /** What it would change, in plain words. */
  change: string;
  applied: boolean;
}

export interface FacePlan {
  id: string;
  family: string;
  adapter: string;
  status: 'planned' | 'skipped' | 'refused';
  reason?: string;
  source?: { file: string; sha256: string; bytes: number };
  license?: { id: string; from: string; reserved?: string[]; rename?: { from: string; to: string } };
  /** Kept characters K (§8.1) and where they came from. */
  kept?: { count: number; used: number; safety: number; locales: string[] };
  files?: PlannedFile[];
  /** Feature tags kept on top of HarfBuzz's default set (§8.7). */
  features?: string[];
  /** Axis pins/ranges (limit-axes); absent: every axis kept whole. */
  axes?: Record<string, AxisSetting>;
  /** @font-face descriptors that change (limit-axes). */
  descriptors?: Record<string, string>;
  hinting?: boolean;
  /**
   * `coreThreshold: 'auto'`, when the site uses characters outside core's fixed part: the ones put
   * in core, and how many of the face's pages then load no other file of the face.
   */
  coreChoice?: { added: string; count: number; pages: number; coreOnly: number };
  /** Characters moved into core so words shape as they did unsplit (§8.3). */
  repair?: { moved: string; count: number; words: string[]; truncated?: boolean };
  /** Words that shape differently across files (only with split-shaping). */
  splitWords?: string[];
  optIns?: OptIn[];
  bytes?: { now: number; core: number; ext: number; rest: number };
  notes?: string[];
}

export interface Plan {
  version: 1;
  faces: FacePlan[];
  /** Opt-ins summed over faces. */
  optIns: { id: OptInId; saving: number; faces: number; applied: boolean }[];
}

// ─── Capabilities (§6, capability matrix) ───────────────────────────────────────────────────────

interface Caps {
  subset: boolean;
  split: 'full' | 'single';
  /** A rest file can be declared (false: next/font/local, one file per face). */ rest?: boolean;
  why?: string;
}
const CAPS: Record<string, Caps> = {
  css: { subset: true, split: 'full' },
  manual: { subset: true, split: 'full' },
  // One file per face: Turbopack (Next 16's default) can't split a localFont() call (§6.3, spike 5).
  'next-font-local': { subset: true, split: 'single', rest: false },
  // Each slice is subset on its own; fontsource's slices are the split (§6.2).
  fontsource: { subset: true, split: 'single' },
  'next-font-google': {
    subset: false,
    split: 'single',
    why: 'Google serves this font through next/font/google; --allow eject serves it from your site, split',
  },
  'google-fonts': {
    subset: false,
    split: 'single',
    why: 'Google serves this font; --allow self-host serves it from your site, split',
  },
  'adobe-fonts': {
    subset: false,
    split: 'single',
    why: "Adobe Fonts serves this kit; Adobe's license allows no changes to the files (see the report, and fontphobia apply-kit)",
  },
  'nuxt-fonts': {
    subset: false,
    split: 'single',
    why: '@nuxt/fonts serves this font; --allow eject serves it from your site, split',
  },
  'astro-fonts': {
    subset: false,
    split: 'single',
    why: "Astro's Fonts API serves this font; --allow eject serves it from your site, split",
  },
  unknown: { subset: false, split: 'single', why: "fontphobia couldn't find where this face is declared" },
};

// ─── Character sets ─────────────────────────────────────────────────────────────────────────────

const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** Printable ASCII, Latin-1 Supplement and Latin Extended-A (§8.1). */
export const SAFETY_LATIN = [...span(0x20, 0x7e), ...span(0xa0, 0xff), ...span(0x100, 0x17f)];
/** C0 and C1 controls: never drawn, so never kept or put in a file. */
const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
/**
 * Core's fixed part (§8.2): printable ASCII and the commonest punctuation. U+2010 and U+2026 must be
 * here: Chrome draws the hyphen of `hyphens: auto` and the ellipsis of `text-overflow` as U+2010 and
 * U+2026 only if the primary font (the file holding U+0020) has them, else as "-" and "..." (M5 notes).
 */
export const CORE_BASE = [...span(0x20, 0x7e), 0xa0, 0x2010, 0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026];
const isMark = (cp: number) => /\p{M}/u.test(String.fromCodePoint(cp));
/** Faces in inputs: every Latin character, plus the punctuation and marks Latin text uses. */
const isLatinish = (cp: number) =>
  /[\p{Script=Latin}\p{M}]/u.test(String.fromCodePoint(cp)) ||
  cp <= 0x24f ||
  (cp >= 0x2000 && cp <= 0x206f) ||
  (cp >= 0x20a0 && cp <= 0x20cf);

const setOf = (ranges: string | undefined) => new Set(ranges ? codePointsOf(parseUnicodeRange(ranges)) : []);
const fmt = (s: Iterable<number>) => formatUnicodeRange(rangesFromCodePoints(s));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const str = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ─── Axes (§8.6, limit-axes) ────────────────────────────────────────────────────────────────────

/** The axis settings limit-axes would use, or undefined when nothing would narrow. */
export function limitAxes(face: UsageFaceJson, axes: Axis[]): Record<string, AxisSetting> | undefined {
  const out: Record<string, AxisSetting> = {};
  let narrows = false;
  const [wMin, wMax] = parseWeightDescriptor(face.descriptors['font-weight']);
  const [sMin, sMax] = parseStretchDescriptor(face.descriptors['font-stretch']);
  for (const a of axes) {
    const vals = new Set<number>([...(face.rendered.axes?.[a.tag] ?? []), ...(face.declared.axes?.[a.tag] ?? [])]);
    if (a.tag === 'wght') {
      // Browser defaults: b/strong are `bolder`, h1–h6 and th are bold (§7.5).
      for (const w of [...vals, ...(face.rendered.weight ?? []), ...(face.declared.weight ?? [])])
        vals.add(relativeWeight('bolder', w));
      vals.add(700);
    }
    const clampD = (v: number) =>
      a.tag === 'wght' ? Math.min(wMax, Math.max(wMin, v)) : a.tag === 'wdth' ? Math.min(sMax, Math.max(sMin, v)) : v;
    const clamped = new Set([...vals].map((v) => Math.min(a.max, Math.max(a.min, clampD(v)))));
    let s: AxisSetting;
    if (clamped.size === 0) s = a.default;
    else if (clamped.size === 1) s = [...clamped][0]!;
    else {
      const lo = Math.min(a.default, ...clamped),
        hi = Math.max(a.default, ...clamped);
      s = { min: lo, max: hi };
    }
    if (typeof s === 'number' ? a.min !== a.max : s.min > a.min || s.max < a.max) narrows = true;
    out[a.tag] = s;
  }
  return narrows ? out : undefined;
}

function axisDescriptors(face: UsageFaceJson, axes: Record<string, AxisSetting>): Record<string, string> {
  const d: Record<string, string> = {};
  const fmtA = (s: AxisSetting, unit = '') =>
    typeof s === 'number' ? `${s}${unit}` : `${s.min}${unit} ${s.max}${unit}`;
  if (axes.wght !== undefined && face.descriptors['font-weight']) d['font-weight'] = fmtA(axes.wght);
  if (axes.wdth !== undefined && face.descriptors['font-stretch']) d['font-stretch'] = fmtA(axes.wdth, '%');
  return d;
}

// ─── Shaping repair (§8.3) ──────────────────────────────────────────────────────────────────────

export interface Word {
  text: string;
  cps: number[];
  cases: ShapeCase[];
}

/** Every stored word in every style context, as shaping cases at each corner of the context's axis ranges (§7.6). */
export function wordsOf(face: UsageFaceJson, keep: Set<number>, axes: Pick<Axis, 'tag'>[]): Word[] {
  const tags = new Set(axes.map((a) => a.tag));
  const out: Word[] = [];
  for (const ctx of face.contexts) {
    const features = ctx.features
      ? ctx.features
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
      : [];
    // Shape at the ends of every axis range (§7.6): every corner.
    let corners: Record<string, number>[] = [{}];
    for (const [t, [lo, hi]] of Object.entries(ctx.axes).toSorted(([a], [b]) => str(a, b))) {
      if (!tags.has(t)) continue;
      corners = corners.flatMap((c) =>
        lo === hi
          ? [{ ...c, [t]: lo }]
          : [
              { ...c, [t]: lo },
              { ...c, [t]: hi },
            ],
      );
    }
    for (const w of ctx.words) {
      // Neighbors another face drew (a space outside this face's unicode-range) aren't shaped here.
      const text = [...w].filter((ch) => keep.has(ch.codePointAt(0)!)).join('');
      if (!text) continue;
      const cps = [...new Set([...text].map((ch) => ch.codePointAt(0)!))];
      out.push({
        text,
        cps,
        cases: corners.map((variations) => ({
          text,
          features,
          variations: Object.keys(variations).length ? variations : undefined,
        })),
      });
    }
  }
  return out;
}

function shapesSplit(
  sfnt: Uint8Array,
  K: Set<number>,
  C: Set<number>,
  words: Word[],
  opts: Omit<SubsetOptions, 'unicodes'>,
): { broken: Word[] } {
  const E = new Set([...K].filter((c) => !C.has(c)));
  const mixed = words.filter((w) => w.cps.some((c) => C.has(c)) && w.cps.some((c) => E.has(c)));
  if (!mixed.length) return { broken: [] };
  const whole = hbSubset(sfnt, { ...opts, unicodes: K });
  const files = [
    { sfnt: hbSubset(sfnt, { ...opts, unicodes: C }), ranges: rangesFromCodePoints(C) as Range[] },
    { sfnt: hbSubset(sfnt, { ...opts, unicodes: E }), ranges: rangesFromCodePoints(E) as Range[] },
  ];
  const cases = mixed.flatMap((w) => w.cases);
  const results = checkShaping(whole, files, cases);
  const bad = new Set<string>();
  results.forEach((r, i) => {
    if (r.verdict.kind !== 'identical') bad.add(cases[i]!.text);
  });
  return { broken: mixed.filter((w) => bad.has(w.text)) };
}

/**
 * The code points HarfBuzz actually maps for `set`: it adds each character's bidi mirror ('>' brings
 * '<'), because RTL shaping looks the mirror up in the same font. Mirroring is symmetric, so once
 * K and core are closed, K − core and the rest are closed too, and the files never overlap.
 */
export function closure(sfnt: Uint8Array, set: Set<number>): Set<number> {
  if (!set.size) return set;
  const got = new Set(
    loadFont(hbSubset(sfnt, { unicodes: set, features: { only: [] }, hinting: false })).face.collectUnicodes(),
  );
  for (const c of set) got.add(c);
  return got;
}

/** Grow core until every stored word shapes the same split as whole. Core only grows, so it ends. */
export function repairCore(
  sfnt: Uint8Array,
  K: Set<number>,
  C0: Set<number>,
  words: Word[],
  opts: Omit<SubsetOptions, 'unicodes'>,
) {
  let C = new Set(C0);
  const moved = new Set<number>();
  const fixed = new Set<string>();
  let first: Word[] | undefined;
  for (let round = 0; round < 50; round++) {
    const { broken } = shapesSplit(sfnt, K, C, words, opts);
    first ??= broken;
    if (!broken.length) break;
    for (const w of broken) {
      fixed.add(w.text);
      for (const c of w.cps) C.add(c);
    }
    C = closure(sfnt, C);
    for (const c of C) if (!C0.has(c)) moved.add(c);
  }
  return { C, moved, words: [...fixed].toSorted(str), firstBroken: (first ?? []).map((w) => w.text).toSorted(str) };
}

/** Single code points that the face's decomposed clusters (base + combining marks) compose to under NFC. */
export function composedInUse(face: Pick<UsageFaceJson, 'contexts'>): Set<number> {
  const out = new Set<number>();
  const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const ctx of face.contexts)
    for (const w of ctx.words) {
      if (!/\p{M}/u.test(w)) continue;
      for (const { segment } of seg.segment(w)) {
        if (!/\p{M}/u.test(segment)) continue;
        const nfc = segment.normalize('NFC');
        if ([...nfc].length === 1 && nfc !== segment) out.add(nfc.codePointAt(0)!);
      }
    }
  return out;
}

// ─── The planner ────────────────────────────────────────────────────────────────────────────────

const hasHinting = (sfnt: Uint8Array) => {
  const t = readSfnt(sfnt).tables;
  return t.has('fpgm') || t.has('prep') || t.has('cvt ') || glyfInstructionBytes(sfnt) > 0;
};

interface Built {
  files: PlannedFile[];
  bytes: Record<Role, number>;
}

/** `outputs`, when given, receives the planned files' WOFF2 bytes by file name (what `build --write` writes). */
export async function planFace(
  id: string,
  face: UsageFaceJson,
  usage: UsageFileJson,
  src: SourceFont | undefined,
  cfg: PlanConfig = {},
  outputs?: Map<string, Uint8Array>,
): Promise<FacePlan> {
  const adapter = face.source.adapter;
  // self-host (§6.5): Google's served file becomes the source, with the full split.
  const caps =
    (adapter === 'google-fonts' && cfg.allow?.includes('self-host')) ||
    ((adapter === 'next-font-google' || adapter === 'astro-fonts' || adapter === 'nuxt-fonts') &&
      cfg.allow?.includes('eject'))
      ? { subset: true, split: 'full' as const }
      : (CAPS[adapter] ?? CAPS.unknown!);
  const base: FacePlan = { id, family: face.family, adapter, status: 'skipped' };
  const now = face.files.reduce((n, f) => Math.max(n, f.bytes ?? 0), 0);
  if (face.local) return { ...base, reason: 'drawn from an installed font (local())' };
  if (!caps.subset) return { ...base, reason: caps.why };
  if (!src)
    return {
      ...base,
      reason: `source font not found in the repo${face.source.fontFile ? ` (${face.source.fontFile})` : ''}`,
    };

  const sfnt = await toSfnt(src.bytes);
  const source = { file: src.file, sha256: sha256(src.bytes), bytes: src.bytes.byteLength };
  const lic = src.license ?? detectLicense(sfnt);
  const allowedLicense = (cfg.licenses?.allow ?? []).some(
    (a) => a.toLowerCase() === face.family.toLowerCase() || a === src.file,
  );
  const refusal = licenseRefusal(sfnt, lic, allowedLicense);
  const license: FacePlan['license'] = {
    id: lic.id,
    from: lic.from,
    reserved: lic.reserved.length ? lic.reserved : undefined,
  };
  if (refusal) return { ...base, status: 'refused', reason: refusal, source, license };
  const rename = renameFor(sfnt, face.family, lic.reserved, cfg.rename);
  if (rename) license.rename = rename;

  const { face: hbFace, font: hbFont } = loadFont(sfnt);
  const cmap = new Set(hbFace.collectUnicodes());
  const byGlyph = reverseCmap(hbFont, cmap);
  const refGlyphs = macosReferenceGlyphs(hbFont);
  const ur = face.descriptors['unicode-range'] ? parseUnicodeRange(face.descriptors['unicode-range']) : undefined;
  const servable = new Set([...cmap].filter((c) => !isControl(c) && (!ur || inRanges(ur, c))));

  // 1. K = (used ∪ safety net) ∩ cmap ∩ unicode-range.
  const used = setOf(face.chars);
  const safety = new Set<number>(SAFETY_LATIN);
  const locales = [...new Set([...(cfg.locales ?? []), ...face.locales])].toSorted(str);
  const unknownLocales: string[] = [];
  for (const l of locales) {
    const cs = localeChars(l);
    if (cs) for (const c of cs) safety.add(c);
    else unknownLocales.push(l);
  }
  if (face.editable) for (const c of cmap) if (isLatinish(c)) safety.add(c);
  for (const c of composedInUse(face)) safety.add(c);
  const mut = cfg.mutation?.face === id ? cfg.mutation : undefined;
  if (mut?.kind === 'drop-char') servable.delete(mut.cp);
  const K = closure(sfnt, new Set([...used, ...safety].filter((c) => servable.has(c))));
  if (mut?.kind === 'drop-char') K.delete(mut.cp);
  const kept = {
    count: K.size,
    used: [...used].filter((c) => K.has(c)).length,
    safety: [...K].filter((c) => !used.has(c)).length,
    locales,
  };

  // Options: features (§8.7), axes (§8.6), hinting (§8.8).
  const allow = new Set(cfg.allow ?? []);
  const fvar = parseFvar(sfnt)?.axes ?? [];
  const features = [...new Set(face.features)]
    .filter((t) => !(mut?.kind === 'drop-feature' && t === mut.tag))
    .toSorted(str);
  const axesLimit = fvar.length ? limitAxes(face, fvar) : undefined;
  const hinted = hasHinting(sfnt);
  const optsFor = (o: { limit: boolean; dropHinting: boolean }): Omit<SubsetOptions, 'unicodes'> => ({
    features: { add: features },
    hinting: !o.dropHinting,
    ...(o.limit && axesLimit ? { axes: axesLimit } : {}),
    ...(mut?.kind === 'pin-axis' ? { axes: { ...(o.limit ? axesLimit : {}), [mut.tag]: mut.value } } : {}),
    ...(license.rename ? { rename: license.rename } : {}),
  });
  const final = { limit: allow.has('limit-axes') && !!axesLimit, dropHinting: allow.has('drop-hinting') && hinted };
  const opts = optsFor(final);
  const refsOn = !allow.has('drop-hint-refs');
  /**
   * What a file's cmap carries outside its unicode-range. For FreeType's auto-hinter: the reference
   * letters (core has them already) and every code point sharing a glyph with one in the file. For
   * macOS: its reference glyphs' code points, when the source maps them.
   */
  const refsFor = (role: Role, set: Set<number>, withRefs: boolean): number[] => {
    const hintBase = role === 'core' || !withRefs ? [] : hintRefs(set, cmap);
    const macRefs = refGlyphs.flatMap((g) => byGlyph.get(g) ?? []).filter((c) => !set.has(c));
    return [
      ...new Set([...hintBase, ...macRefs, ...cmapAliases([...set, ...hintBase, ...macRefs], hbFont, byGlyph)]),
    ].toSorted((a, b) => a - b);
  };

  // 2. Core: its fixed part, plus the used characters `coreThreshold` picks, ∩ K.
  /** For each page of the face, the characters it draws there. */
  const drawn = face.pages.map((p) => setOf(usage.pages[p]?.faces[id]));
  let C0: Set<number>;
  /** auto, when the pages use characters outside core's fixed part: that fixed part. */
  let fixedCore: Set<number> | undefined;
  const auto = caps.split !== 'single' && (cfg.coreThreshold ?? 'auto') === 'auto';
  /**
   * auto: the used characters to add to `from` so the pages download the least (plan/core.ts). Sizes
   * are of the subsets the files are made from, with the same references the files will carry,
   * compressed.
   */
  const chooseFrom = (from: Set<number>) => {
    const size = (role: Role, set: Set<number>) =>
      set.size
        ? compressedSize(
            hbSubset(sfnt, { ...opts, unicodes: [...set, ...refsFor(role, set, refsOn)], glyphs: refGlyphs }),
          )
        : 0;
    return chooseCore(
      drawn.map((cs) => [...cs].filter((c) => K.has(c) && !from.has(c))),
      (add) => {
        const core = new Set([...from, ...add]);
        return { core: size('core', core), ext: size('ext', new Set([...K].filter((c) => !core.has(c)))) };
      },
    );
  };
  if (caps.split === 'single') C0 = new Set(K);
  else {
    const threshold = cfg.coreThreshold ?? 'auto';
    C0 = new Set(CORE_BASE);
    if (threshold !== 'auto') {
      const n = face.pages.length;
      const counts = new Map<number, number>();
      for (const cs of drawn) for (const c of cs) counts.set(c, (counts.get(c) ?? 0) + 1);
      for (const [c, k] of counts) if (n && k / n >= threshold) C0.add(c);
    }
    for (const c of used) if (isMark(c)) C0.add(c);
    // Decomposed text (e + U+0301): Firefox and WebKit match fonts on the composed cluster (é), so the
    // composed character goes with its base and marks (M5 notes).
    for (const c of composedInUse(face)) if (cmap.has(c) && servable.has(c)) C0.add(c);
    // List markers: WebKit lays a marker out with the primary font (core), so a marker symbol from
    // another file lands a fraction of a pixel off (M5 notes).
    for (const c of setOf(face.inserted['list markers'])) C0.add(c);
    C0 = closure(sfnt, new Set([...C0].filter((c) => K.has(c))));
    if (auto) {
      const fixed = C0;
      const pick = chooseFrom(fixed);
      if (pick.measured) {
        fixedCore = fixed;
        C0 = closure(sfnt, new Set([...fixed, ...pick.add]));
      }
    }
  }

  // 3. Cross-file shaping repair.
  const words = caps.split === 'full' ? wordsOf(face, K, fvar) : [];
  const splitShaping = allow.has('split-shaping');
  let rep =
    caps.split === 'full' && C0.size < K.size
      ? repairCore(sfnt, K, C0, words, opts)
      : { C: C0, moved: new Set<number>(), words: [], firstBroken: [] };
  // auto, again: the repair can leave a page a few characters short of loading core alone, at a
  // price the first choice never saw (it priced those pages' letters before the repair moved most
  // of them). Choose from the repaired core, and repair what that adds, until the repair adds nothing.
  /** auto: the characters chosen after the repair. */
  const later = new Set<number>();
  for (;;) {
    if (!auto || !rep.moved.size || rep.C.size === K.size) break;
    const from = rep.C;
    const pick = chooseFrom(from);
    if (!pick.add.size) break;
    const grown = closure(sfnt, new Set([...from, ...pick.add]));
    for (const c of grown) if (!from.has(c)) later.add(c);
    const next = repairCore(sfnt, K, grown, words, opts);
    rep = {
      C: next.C,
      moved: new Set([...rep.moved, ...next.moved]),
      words: [...new Set([...rep.words, ...next.words])].toSorted(str),
      firstBroken: rep.firstBroken,
    };
    if (!next.moved.size) break;
  }
  let C = splitShaping ? C0 : rep.C;
  if (mut?.kind === 'mark-out-of-core') C = new Set([...C].filter((c) => !isMark(c)));

  // 4–5. Extended and rest.
  const setsFor = (core: Set<number>) => {
    const E = new Set([...K].filter((c) => !core.has(c)));
    const R =
      cfg.remainder === false || caps.rest === false
        ? new Set<number>()
        : new Set([...servable].filter((c) => !K.has(c)));
    return { core, ext: E, rest: R };
  };
  const stem = basename(src.file, extname(src.file));
  const cache = new Map<string, PlannedFile>();
  const bytesOf = new Map<string, Uint8Array>();
  const build = async (
    role: Role,
    set: Set<number>,
    o: Omit<SubsetOptions, 'unicodes'>,
    withRefs = refsOn,
  ): Promise<PlannedFile | undefined> => {
    if (!set.size) return undefined;
    // Core never carries references, so it's the same file either way.
    const key = `${role}|${fmt(set)}|${JSON.stringify(o)}|${withRefs && role !== 'core'}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const refs = refsFor(role, set, withRefs);
    const r = await subsetFont(sfnt, { ...o, unicodes: [...set, ...refs], glyphs: refGlyphs });
    const h = sha256(r.woff2);
    const refSet = new Set(refs);
    const served = r.unicodes.filter((c) => !refSet.has(c));
    const f: PlannedFile = {
      role,
      unicodeRange: fmt(served),
      count: served.length,
      bytes: r.woff2.byteLength,
      sha256: h,
      name: `${stem}.${role}.${h.slice(0, 8)}.woff2`,
      ...(refs.length ? { hintRefs: fmt(refs) } : {}),
    };
    cache.set(key, f);
    bytesOf.set(f.name, r.woff2);
    return f;
  };
  const buildAll = async (
    core: Set<number>,
    o: Omit<SubsetOptions, 'unicodes'>,
    withRest: boolean,
    withRefs = refsOn,
  ): Promise<Built> => {
    const s = setsFor(core);
    const files = (
      await Promise.all([
        build('core', s.core, o, withRefs),
        build('ext', s.ext, o, withRefs),
        withRest ? build('rest', s.rest, o, withRefs) : undefined,
      ])
    ).filter((f): f is PlannedFile => !!f);
    const bytes = { core: 0, ext: 0, rest: 0 };
    for (const f of files) bytes[f.role] = f.bytes;
    return { files, bytes };
  };
  const out = await buildAll(C, opts, true);
  if (outputs) for (const f of out.files) outputs.set(f.name, bytesOf.get(f.name)!);
  const paid = (b: Built) => b.bytes.core + b.bytes.ext;

  // Opt-ins: each measured by toggling it against the final plan.
  const optIns: OptIn[] = [];
  if (axesLimit) {
    const other = await buildAll(C, optsFor({ ...final, limit: !final.limit }), false);
    const desc = Object.entries(axesLimit)
      .map(([t, s]) => `${t} ${typeof s === 'number' ? `pinned at ${s}` : `${s.min}–${s.max}`}`)
      .join(', ');
    optIns.push({
      id: 'limit-axes',
      applied: final.limit,
      saving: final.limit ? paid(other) - paid(out) : paid(out) - paid(other),
      change: `${desc}; text widths shift up to ~0.02% (whole pixels on Linux at 1×)`,
    });
  }
  if (hinted) {
    const other = await buildAll(C, optsFor({ ...final, dropHinting: !final.dropHinting }), false);
    optIns.push({
      id: 'drop-hinting',
      applied: final.dropHinting,
      saving: final.dropHinting ? paid(other) - paid(out) : paid(out) - paid(other),
      change: 'changes text layout on Linux at 1× and rasterization on Windows',
    });
  }
  if (out.files.some((f) => f.role !== 'core')) {
    const other = await buildAll(C, opts, false, !refsOn);
    const saving = refsOn ? paid(out) - paid(other) : paid(other) - paid(out);
    if (saving > 0)
      optIns.push({
        id: 'drop-hint-refs',
        applied: !refsOn,
        saving,
        change: "characters from the extended file hint differently on Linux and ChromeOS (FreeType's auto-hinter)",
      });
  }
  if (rep.moved.size) {
    const other = await buildAll(splitShaping ? rep.C : C0, opts, false);
    const n = rep.firstBroken.length;
    // What the repair costs: the extra core bytes every page using the face downloads (§8.3).
    optIns.push({
      id: 'split-shaping',
      applied: splitShaping,
      saving: splitShaping ? other.bytes.core - out.bytes.core : out.bytes.core - other.bytes.core,
      change: `loses kerning or contextual forms in ${n} word${n === 1 ? '' : 's'} where core and extended characters meet`,
    });
  }

  // auto: what it put in core, and the pages that draw nothing from the other two files.
  const fixedPart = fixedCore;
  const chosen = fixedPart
    ? [...new Set([...C0, ...(splitShaping ? [] : later)])].filter((c) => !fixedPart.has(c))
    : [];
  const elsewhere = setsFor(C);

  const notes: string[] = [];
  if (unknownLocales.length) notes.push(`CLDR has no characters for ${unknownLocales.join(', ')}`);
  if (face.wordsTruncated) notes.push('word list was capped: the shaping repair saw only part of the text');
  if (!hinted && !readSfnt(sfnt).tables.has('CFF ')) notes.push('no TrueType hinting to drop');
  if (caps.split === 'single')
    notes.push(
      adapter === 'next-font-local'
        ? "next/font/local: one file per face (Turbopack can't split a localFont() call); characters outside it fall back to the next font"
        : `${adapter}: one file per slice, no core/extended split`,
    );
  const plan: FacePlan = {
    ...base,
    status: 'planned',
    source,
    license,
    kept,
    files: out.files,
    features,
    hinting: !final.dropHinting,
    axes: final.limit ? axesLimit : undefined,
    descriptors: final.limit && axesLimit ? axisDescriptors(face, axesLimit) : undefined,
    coreChoice: fixedPart && {
      added: fmt(chosen),
      count: chosen.length,
      pages: drawn.length,
      coreOnly: drawn.filter((cs) => ![...cs].some((c) => elsewhere.ext.has(c) || elsewhere.rest.has(c))).length,
    },
    repair:
      rep.moved.size && !splitShaping
        ? {
            moved: fmt(rep.moved),
            count: rep.moved.size,
            words: rep.words.slice(0, 50),
            truncated: rep.words.length > 50 || undefined,
          }
        : undefined,
    splitWords: splitShaping && rep.firstBroken.length ? rep.firstBroken.slice(0, 50) : undefined,
    optIns: optIns.toSorted((a, b) => str(a.id, b.id)),
    bytes: { now, ...out.bytes },
    notes: notes.length ? notes : undefined,
  };
  return plan;
}

export async function planAll(
  usage: UsageFileJson,
  sources: Map<string, SourceFont>,
  cfg: PlanConfig = {},
  outputs?: Map<string, Uint8Array>,
): Promise<Plan> {
  if (usage.version !== 1)
    throw new Error(`usage.json version ${usage.version} isn't supported by this fontphobia; rerun audit`);
  const unknown = (cfg.allow ?? []).filter(
    (a) =>
      !(OPT_INS as readonly string[]).includes(a) &&
      !['self-host', 'tighten', 'to-local', 'eject', 'add-preloads'].includes(a),
  );
  if (unknown.length)
    throw new Error(`Unknown opt-in ${unknown.join(', ')}; known: ${[...OPT_INS, 'self-host', 'tighten'].join(', ')}`);
  const faces: FacePlan[] = [];
  // Sequential: wawoff2 is serialized anyway, and the order keeps the output stable.
  // One face that fails (a font the subsetter can't handle as planned) is left as it is, with the error; the others still plan.
  for (const id of Object.keys(usage.faces).toSorted(str)) {
    const face = usage.faces[id]!;
    try {
      faces.push(await planFace(id, face, usage, sources.get(id), cfg, outputs));
    } catch (e) {
      faces.push({
        id,
        family: face.family,
        adapter: face.source.adapter,
        status: 'skipped',
        reason: `planning it failed: ${(e as Error).message}`,
      });
    }
  }
  const optIns = OPT_INS.map((oid) => {
    const hits = faces.flatMap((f) => f.optIns?.filter((o) => o.id === oid) ?? []);
    return {
      id: oid,
      saving: hits.reduce((n, o) => n + o.saving, 0),
      faces: hits.length,
      applied: hits.some((o) => o.applied),
    };
  }).filter((o) => o.faces);
  return { version: 1, faces, optIns };
}
