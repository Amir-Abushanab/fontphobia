// Thin helpers over harfbuzzjs 1.6.4: raw subset WASM + the JS shaping API.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as hb from 'harfbuzzjs';
import wawoff2 from 'wawoff2';

const require = createRequire(import.meta.url);
export { hb };

export const tag = (s) => [...s].reduce((a, c) => ((a << 8) | c.charCodeAt(0)) >>> 0, 0);

let sub;
async function subsetWasm() {
  if (sub) return sub;
  const { instance } = await WebAssembly.instantiate(
    readFileSync(require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')),
  );
  instance.exports._initialize();
  return (sub = instance.exports);
}

const SETS = { DROP_TABLE_TAG: 3, NAME_ID: 4, NAME_LANG_ID: 5, LAYOUT_FEATURE_TAG: 6 };
const FLAGS = { NO_HINTING: 0x1, RETAIN_GIDS: 0x2, GLYPH_NAMES: 0x80, NO_LAYOUT_CLOSURE: 0x200 };

/**
 * subset(sfnt, opts) -> Uint8Array sfnt
 * opts.unicodes: iterable of code points (default: all)
 * opts.axes: { wght: 400 | {min,max,default?} }
 * opts.features: undefined (HarfBuzz default set) | '*' | string[]
 * opts.nameIds: undefined (default 0-6) | '*' | number[]
 * opts.hinting: true (default) | false
 */
export async function subset(sfnt, opts = {}) {
  const w = await subsetWasm();
  const heap = () => new Uint8Array(w.memory.buffer);
  const input = w.hb_subset_input_create_or_fail();
  const ptr = w.malloc(sfnt.byteLength);
  heap().set(sfnt, ptr);
  const blob = w.hb_blob_create(ptr, sfnt.byteLength, 2, 0, 0);
  const face = w.hb_face_create(blob, 0);
  w.hb_blob_destroy(blob);

  const setAll = (s) => {
    w.hb_set_clear(s);
    w.hb_set_invert(s);
  };
  if (opts.features !== undefined) {
    const s = w.hb_subset_input_set(input, SETS.LAYOUT_FEATURE_TAG);
    w.hb_set_clear(s);
    if (opts.features === '*') setAll(s);
    else for (const f of opts.features) w.hb_set_add(s, tag(f));
  }
  if (opts.nameIds !== undefined) {
    const s = w.hb_subset_input_set(input, SETS.NAME_ID);
    if (opts.nameIds === '*') setAll(s);
    else {
      w.hb_set_clear(s);
      for (const n of opts.nameIds) w.hb_set_add(s, n);
    }
  }
  for (const t of opts.dropTables ?? []) w.hb_set_add(w.hb_subset_input_set(input, SETS.DROP_TABLE_TAG), tag(t));
  if (opts.nameLangs === '*') setAll(w.hb_subset_input_set(input, SETS.NAME_LANG_ID));
  let flags = w.hb_subset_input_get_flags(input);
  if (opts.hinting === false) flags |= FLAGS.NO_HINTING;
  w.hb_subset_input_set_flags(input, flags);

  const u = w.hb_subset_input_unicode_set(input);
  if (opts.unicodes === undefined) setAll(u);
  else for (const c of opts.unicodes) w.hb_set_add(u, c);

  for (const [axis, v] of Object.entries(opts.axes ?? {})) {
    const ok =
      typeof v === 'number'
        ? w.hb_subset_input_pin_axis_location(input, face, tag(axis), v)
        : w.hb_subset_input_set_axis_range(input, face, tag(axis), v.min, v.max, v.default ?? NaN);
    if (!ok) throw new Error(`axis ${axis} failed`);
  }
  const out = w.hb_subset_or_fail(face, input);
  w.hb_subset_input_destroy(input);
  if (!out) throw new Error('hb_subset_or_fail');
  const rb = w.hb_face_reference_blob(out);
  const data = heap().slice(w.hb_blob_get_data(rb, 0), w.hb_blob_get_data(rb, 0) + w.hb_blob_get_length(rb));
  w.hb_blob_destroy(rb);
  w.hb_face_destroy(out);
  w.hb_face_destroy(face);
  w.free(ptr);
  return data;
}

// wawoff2 2.0.1 resolves with a view into its WASM heap, so overlapping calls corrupt
// each other. Serialize and copy before the next call starts.
let chain = Promise.resolve();
const serial = (fn) => (b) => (chain = chain.then(async () => new Uint8Array(await fn(b)).slice()));
export const woff2 = { decompress: serial(wawoff2.decompress), compress: serial(wawoff2.compress) };

export function load(buf) {
  const face = new hb.Face(new hb.Blob(buf));
  return { face, font: new hb.Font(face) };
}

/** Shape text; returns [{g, cl, ax, ay, dx, dy}] in font units. */
export function shape(font, text, { features = [], variations } = {}) {
  if (variations) font.setVariations(Object.entries(variations).map(([t, v]) => ({ tag: t, value: v })));
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font, buf, features);
  const pos = buf.getGlyphPositions();
  return buf
    .getGlyphInfos()
    .map((g, i) => ({
      g: g.codepoint,
      cl: g.cluster,
      ax: pos[i].xAdvance,
      ay: pos[i].yAdvance,
      dx: pos[i].xOffset,
      dy: pos[i].yOffset,
    }));
}

/** Flat list of outline points for a glyph (font units). */
export function points(font, gid) {
  const out = [];
  for (const c of font.glyphToJson(gid))
    for (let i = 0; i + 1 < c.values.length; i += 2) out.push([c.values[i], c.values[i + 1]]);
  return out;
}

export function glyphFor(font, cp) {
  const r = shape(font, String.fromCodePoint(cp));
  return r.length === 1 ? r[0].g : -1;
}

export async function readSfnt(path) {
  const b = new Uint8Array(readFileSync(path));
  return String.fromCharCode(...b.subarray(0, 4)) === 'wOF2' ? woff2.decompress(b) : b;
}

export function setVars(font, coords) {
  font.setVariations(Object.entries(coords).map(([t, v]) => new hb.Variation(t, v)));
}
