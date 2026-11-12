// Low-level subsetting (PLAN §9.1–9.5): HarfBuzz subset → post-process → assert metrics →
// WOFF2 → decode again and validate. Pure and deterministic: same bytes + options → same output.
import { getSubsetWasm, hbTag, loadFont } from '../font/hb.ts';
import { toSfnt, woff2Compress, woff2Decompress } from '../font/io.ts';
import { readSfnt, withTables } from '../font/sfnt.ts';
import { renameTable, RENAMED_IDS } from '../font/rename.ts';
import { parseFvar, parseHead, parseHhea, parseOs2, setHeadDates, setXAvgCharWidth, nameStrings } from '../font/tables.ts';

export type AxisSetting = number | { min: number; max: number; default?: number };

export interface SubsetOptions {
  /** Code points to keep. '*' keeps every code point in the font. */
  unicodes: Iterable<number> | '*';
  /**
   * Layout features.
   * - `{ add }` (default): HarfBuzz's default retained set plus `add` (what CSS enables, §7.5).
   * - `'*'`: keep every feature.
   * - `{ only }`: exactly these tags.
   */
  features?: { add?: string[] } | '*' | { only: string[] };
  /** name IDs to keep. Default: §8.10 (0–6, 13, 14, 16, 17, 25); HarfBuzz adds the fvar/STAT ones. */
  nameIds?: number[] | '*';
  /** Axis pins (number) or ranges. Opt-in `limit-axes` only (§8.6). */
  axes?: Record<string, AxisSetting>;
  /** Keep TrueType hinting (default true, §8.8). */
  hinting?: boolean;
  /** Rewrite the family in the internal names (OFL Reserved Font Names, §11). */
  rename?: { from: string; to: string };
  /** Raw hb_subset flags OR'd in (diagnostics, e.g. 0x2 retain glyph ids). */
  flags?: number;
  /** Glyph ids to keep without cmap entries (macOS's reference glyphs, plan/hintrefs.ts). */
  glyphs?: number[];
}

export const DEFAULT_NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17, 25] as const;

const SETS = { GLYPH_INDEX: 0, DROP_TABLE_TAG: 3, NAME_ID: 4, NAME_LANG_ID: 5, LAYOUT_FEATURE_TAG: 6 } as const;
const FLAG_NO_HINTING = 0x1;
const FLAG_GLYPH_NAMES = 0x80;
const FLAG_NOTDEF_OUTLINE = 0x40;
/** Always dropped (§8.9): no effect on rendering. */
const ALWAYS_DROP = ['DSIG'];

const isTag = (t: string) => /^[\x20-\x7e]{4}$/.test(t);

/** Run the HarfBuzz subsetter. Input and output are sfnt. */
export function hbSubset(sfnt: Uint8Array, opts: SubsetOptions): Uint8Array {
  const w = getSubsetWasm();
  const heap = () => new Uint8Array(w.memory.buffer);
  const input = w.hb_subset_input_create_or_fail();
  if (!input) throw new Error('hb_subset_input_create_or_fail failed');
  const ptr = w.malloc(sfnt.byteLength);
  heap().set(sfnt, ptr);
  const blob = w.hb_blob_create(ptr, sfnt.byteLength, 2 /* writable */, 0, 0);
  const face = w.hb_face_create(blob, 0);
  w.hb_blob_destroy(blob);
  const all = (s: number) => { w.hb_set_clear(s); w.hb_set_invert(s); };
  try {
    const feats = w.hb_subset_input_set(input, SETS.LAYOUT_FEATURE_TAG);
    const f = opts.features ?? {};
    if (f === '*') all(feats);
    else if ('only' in f) {
      w.hb_set_clear(feats);
      for (const t of f.only) { if (!isTag(t)) throw new Error(`Bad feature tag ${JSON.stringify(t)}`); w.hb_set_add(feats, hbTag(t)); }
    } else {
      // The set starts as HarfBuzz's default list; adding keeps those.
      for (const t of f.add ?? []) { if (!isTag(t)) throw new Error(`Bad feature tag ${JSON.stringify(t)}`); w.hb_set_add(feats, hbTag(t)); }
    }

    const names = w.hb_subset_input_set(input, SETS.NAME_ID);
    if (opts.nameIds === '*') { all(names); all(w.hb_subset_input_set(input, SETS.NAME_LANG_ID)); }
    else { w.hb_set_clear(names); for (const id of opts.nameIds ?? DEFAULT_NAME_IDS) w.hb_set_add(names, id); }

    const drop = w.hb_subset_input_set(input, SETS.DROP_TABLE_TAG);
    for (const t of ALWAYS_DROP) w.hb_set_add(drop, hbTag(t));

    let flags = w.hb_subset_input_get_flags(input);
    if (opts.hinting === false) flags |= FLAG_NO_HINTING;
    // Keep glyph names (post format 2). Dropping them (HarfBuzz's default) changes how Chrome on macOS
    // rasterizes the text: ~1,700 pixels differ on a short Inter paragraph (M5 notes).
    flags |= FLAG_GLYPH_NAMES;
    // Keep .notdef's outline: a character no installed font has is drawn as the primary font's
    // .notdef box, so an empty one changes those boxes and the line height around them (M6 notes).
    flags |= FLAG_NOTDEF_OUTLINE;
    flags |= opts.flags ?? 0;
    w.hb_subset_input_set_flags(input, flags);

    if (opts.glyphs?.length) { const gs = w.hb_subset_input_set(input, SETS.GLYPH_INDEX); for (const g of opts.glyphs) w.hb_set_add(gs, g); }
    const u = w.hb_subset_input_unicode_set(input);
    if (opts.unicodes === '*') all(u);
    else for (const c of opts.unicodes) w.hb_set_add(u, c);

    for (const [axis, v] of Object.entries(opts.axes ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const ok = typeof v === 'number'
        ? w.hb_subset_input_pin_axis_location(input, face, hbTag(axis), v)
        : w.hb_subset_input_set_axis_range(input, face, hbTag(axis), v.min, v.max, v.default ?? NaN);
      if (!ok) throw new Error(`Can't set axis '${axis}' (does the font have it, and is the value in range?)`);
    }

    const out = w.hb_subset_or_fail(face, input);
    if (!out) throw new Error('hb_subset_or_fail failed');
    const rb = w.hb_face_reference_blob(out);
    const start = w.hb_blob_get_data(rb, 0);
    const data = heap().slice(start, start + w.hb_blob_get_length(rb));
    w.hb_blob_destroy(rb);
    w.hb_face_destroy(out);
    return data;
  } finally {
    w.hb_subset_input_destroy(input);
    w.hb_face_destroy(face);
    w.free(ptr);
  }
}

export class MetricsChangedError extends Error {}

/** §9.2–9.3: restore head dates and xAvgCharWidth; assert vertical metrics. */
export function postProcess(source: Uint8Array, subset: Uint8Array, opts: SubsetOptions): Uint8Array {
  const out = readSfnt(subset).tables;
  const patch: Record<string, Uint8Array> = {};
  const h = parseHead(source);
  patch.head = setHeadDates(out.get('head')!, h.created, h.modified);
  const srcOs2 = parseOs2(source);
  if (srcOs2 && out.get('OS/2')) patch['OS/2'] = setXAvgCharWidth(out.get('OS/2')!, srcOs2.xAvgCharWidth);
  if (opts.rename) patch.name = renameTable(subset, opts.rename.from, opts.rename.to);
  const result = withTables(subset, patch);

  checkMetrics(source, result, Object.values(opts.axes ?? {}).some((v) => typeof v === 'number'));
  return result;
}

/** §9.3: an output keeps the source's vertical metrics (a pinned instance may move them via MVAR). */
export function checkMetrics(source: Uint8Array, result: Uint8Array, pinned: boolean): void {
  const srcOs2 = parseOs2(source);
  const a = { head: parseHead(source), hhea: parseHhea(source), os2: srcOs2 };
  const b = { head: parseHead(result), hhea: parseHhea(result), os2: parseOs2(result) };
  const checks: [string, unknown, unknown][] = [['unitsPerEm', a.head.unitsPerEm, b.head.unitsPerEm]];
  if (!pinned) {
    // A pinned instance applies MVAR, which may legitimately move these (limit-axes, §8.6).
    checks.push(['hhea.ascender', a.hhea.ascender, b.hhea.ascender], ['hhea.descender', a.hhea.descender, b.hhea.descender], ['hhea.lineGap', a.hhea.lineGap, b.hhea.lineGap]);
    if (a.os2 && b.os2) {
      for (const k of ['sTypoAscender', 'sTypoDescender', 'sTypoLineGap', 'usWinAscent', 'usWinDescent'] as const) checks.push([`OS/2.${k}`, a.os2[k], b.os2[k]]);
    }
  }
  if (a.os2 && b.os2) checks.push(['OS/2.fsSelection.USE_TYPO_METRICS', a.os2.useTypoMetrics, b.os2.useTypoMetrics]);
  const bad = checks.filter(([, x, y]) => x !== y);
  if (bad.length) throw new MetricsChangedError(`Subsetting changed font metrics: ${bad.map(([k, x, y]) => `${k} ${x} → ${y}`).join(', ')}`);
}

export interface SubsetResult {
  /** The WOFF2 file to ship. */
  woff2: Uint8Array;
  /** The WOFF2 decoded again: what browsers receive, and what every check runs on. */
  decoded: Uint8Array;
  /** Code points the output maps (sorted). */
  unicodes: number[];
}

export class ValidationError extends Error {}

function sortedUnicodes(sfnt: Uint8Array): number[] {
  return [...loadFont(sfnt).face.collectUnicodes()].sort((x, y) => x - y);
}

/** Subset any font container to a validated WOFF2 (§9.1–9.5, without the browser OTS check). */
export async function subsetFont(sourceBytes: Uint8Array, opts: SubsetOptions): Promise<SubsetResult> {
  const source = await toSfnt(sourceBytes);
  const processed = postProcess(source, hbSubset(source, opts), opts);
  const woff2 = await woff2Compress(processed);
  const decoded = await woff2Decompress(woff2);

  const have = validateOutput(source, decoded, opts);
  return { woff2, decoded, unicodes: have };
}

/** `cps` plus the bidi mirrors HarfBuzz keeps (the planner's `closure`, which this module can't import without a cycle). */
function mirrorClosure(sfnt: Uint8Array, cps: number[]): number[] {
  if (!cps.length) return cps;
  const got = new Set(loadFont(hbSubset(sfnt, { unicodes: new Set(cps), features: { only: [] }, hinting: false })).face.collectUnicodes());
  for (const c of cps) got.add(c);
  return [...got];
}

/** §9.5 on a decoded output: cmap exactly as planned, axes, and preserved (or renamed) names. Returns the cmap. */
export function validateOutput(source: Uint8Array, decoded: Uint8Array, opts: SubsetOptions): number[] {
  const have = sortedUnicodes(decoded);
  const srcSet = new Set(sortedUnicodes(source));
  let want = opts.unicodes === '*' ? [...srcSet].sort((x, y) => x - y) : [...new Set(opts.unicodes)].filter((c) => srcSet.has(c)).sort((x, y) => x - y);
  const differs = () => have.length !== want.length || have.some((c, i) => c !== want[i]);
  // The output cmap must be exactly the requested set ∩ the source cmap, plus HarfBuzz's bidi mirrors ('>' brings '<').
  // The planner asks for closed sets, so the closure is only worked out when the plain comparison fails.
  if (opts.unicodes !== '*' && differs()) want = mirrorClosure(source, want).sort((x, y) => x - y);
  if (differs()) {
    const hs = new Set(have);
    const missing = want.filter((c) => !hs.has(c)).slice(0, 10);
    const extra = have.filter((c) => !want.includes(c)).slice(0, 10);
    throw new ValidationError(`Output cmap differs from the plan (missing ${fmt(missing)}, extra ${fmt(extra)})`);
  }
  const srcAxes = parseFvar(source)?.axes ?? [];
  const outAxes = parseFvar(decoded)?.axes ?? [];
  const expectAxes = srcAxes.filter((ax) => typeof opts.axes?.[ax.tag] !== 'number').map((ax) => ax.tag);
  if (outAxes.map((x) => x.tag).join() !== expectAxes.join()) {
    throw new ValidationError(`Output axes ${outAxes.map((x) => x.tag).join(',') || 'none'} ≠ expected ${expectAxes.join(',') || 'none'}`);
  }
  const srcNames = nameStrings(source);
  const outNames = nameStrings(decoded);
  const keep = opts.nameIds === '*' ? [...srcNames.keys()] : (opts.nameIds ?? DEFAULT_NAME_IDS);
  for (const id of keep) {
    if (opts.rename && RENAMED_IDS.has(id)) {
      if (outNames.get(id)?.includes(opts.rename.from)) throw new ValidationError(`name ID ${id} still contains ${JSON.stringify(opts.rename.from)}`);
      continue;
    }
    if (srcNames.has(id) && outNames.get(id) !== srcNames.get(id)) throw new ValidationError(`name ID ${id} was not preserved`);
  }
  return have;
}

const fmt = (cps: number[]) => (cps.length ? cps.map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0')).join(' ') : 'none');
