// HarfBuzz access: the raw subsetter WASM (harfbuzz-subset.wasm has no JS glue) and the
// harfbuzzjs shaping API (harfbuzz.wasm). Both come from harfbuzzjs@1.6.4 (HarfBuzz 15.0.0).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';

export { hb };
const require = createRequire(import.meta.url);

export const hbTag = (s: string): number =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

/** Locate a vendored WASM file: next to the bundle when published, in node_modules in dev. */
function wasmPath(name: string): string {
  const bundled = fileURLToPath(new URL(`./${name}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return require.resolve(`harfbuzzjs/dist/${name}`);
}

export interface SubsetWasm {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_data(b: number, lenOut: number): number;
  hb_blob_get_length(b: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_set(i: number, which: number): number;
  hb_subset_input_unicode_set(i: number): number;
  hb_subset_input_get_flags(i: number): number;
  hb_subset_input_set_flags(i: number, flags: number): void;
  hb_subset_input_pin_axis_location(i: number, face: number, tag: number, value: number): number;
  hb_subset_input_set_axis_range(i: number, face: number, tag: number, min: number, max: number, def: number): number;
  hb_subset_or_fail(face: number, input: number): number;
  hb_set_add(s: number, v: number): void;
  hb_set_clear(s: number): void;
  hb_set_invert(s: number): void;
}

let subsetWasm: SubsetWasm | undefined;
export function getSubsetWasm(): SubsetWasm {
  if (subsetWasm) return subsetWasm;
  const mod = new WebAssembly.Module(readFileSync(wasmPath('harfbuzz-subset.wasm')));
  const instance = new WebAssembly.Instance(mod, {});
  const exp = instance.exports as unknown as SubsetWasm & { _initialize?: () => void };
  // eslint-disable-next-line no-underscore-dangle -- the WASM module's export name
  exp._initialize?.();
  subsetWasm = exp;
  return exp;
}

export interface LoadedFont {
  face: hb.Face;
  font: hb.Font;
  upem: number;
}
export function loadFont(sfnt: Uint8Array): LoadedFont {
  const face = new hb.Face(new hb.Blob(sfnt));
  return { face, font: new hb.Font(face), upem: face.upem };
}

export function setVariations(font: hb.Font, coords: Record<string, number> | undefined): void {
  font.setVariations(Object.entries(coords ?? {}).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([t, v]) => new hb.Variation(t, v)));
}

export const harfbuzzVersion = (): string => hb.versionString();
