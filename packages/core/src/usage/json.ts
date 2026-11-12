// usage.json (§7.6): canonical serialization. Keys sorted, code points as merged ranges, LF.
import type { AxisUse, FaceUsage, Usage } from './build.ts';
import { charsToRanges } from './build.ts';

export const USAGE_VERSION = 1;

export interface FaceSource {
  /** Adapter id (§6), or "unknown". */
  adapter: string;
  /** Repo file and line of the declaration, when found. */
  file?: string;
  line?: number;
  /** Repo file the served bytes match (sha256). */
  fontFile?: string;
  /** For faces fontphobia generated: the source font's sha256 (the served bytes are the subsets). */
  sha256?: string;
  note?: string;
}

export interface UsageMeta {
  fontphobia: string;
  harfbuzz: string;
  chrome: string;
  framework: string;
  mode: 'static' | 'server' | 'url';
  viewports: number[];
  fontSizes: number[];
}

const num = (a: number, b: number) => a - b;
const str = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedNums = (s: Iterable<number>) => [...new Set(s)].toSorted(num);

function axes(a: AxisUse) {
  const out: Record<string, unknown> = {};
  if (a.weight.size) out.weight = sortedNums(a.weight);
  if (a.stretch.size && !(a.stretch.size === 1 && a.stretch.has(100))) out.stretch = sortedNums(a.stretch);
  if (a.style.size) out.style = [...a.style].toSorted(str);
  if (a.size.size) out.size = sortedNums(a.size);
  if (a.axes.size) out.axes = Object.fromEntries([...a.axes].toSorted(([x], [y]) => str(x, y)).map(([t, v]) => [t, sortedNums(v)]));
  return out;
}

function face(u: FaceUsage, source: FaceSource | undefined) {
  return {
    family: u.family,
    descriptors: u.descriptors,
    sheet: u.sheet,
    source: source ?? { adapter: 'unknown' },
    files: [...u.files].toSorted(([a], [b]) => str(a, b)).map(([url, f]) => ({ url, sha256: f.sha256, bytes: f.bytes })),
    chars: charsToRanges(u.chars),
    count: u.chars.size,
    inserted: Object.fromEntries([...u.inserted].filter(([, s]) => s.size).toSorted(([a], [b]) => str(a, b)).map(([k, s]) => [k, charsToRanges(s)])),
    contexts: [...u.contexts.values()].toSorted((a, b) => str(a.features, b.features))
      .map((c) => ({ features: c.features, axes: Object.fromEntries([...c.axes].toSorted(([x], [y]) => str(x, y))), words: [...c.words].toSorted(str) })),
    rendered: axes(u.rendered),
    declared: axes(u.declared),
    features: [...u.features].toSorted(str),
    editable: u.editable || undefined,
    local: u.local || undefined,
    wordsTruncated: u.wordsTruncated || undefined,
    locales: [...u.locales].toSorted(str),
    pages: [...u.pages.keys()].toSorted(str),
  };
}

export function usageToJson(usage: Usage, meta: UsageMeta, sources: Map<string, FaceSource> = new Map(), extra: Record<string, unknown> = {}) {
  return {
    version: USAGE_VERSION,
    meta,
    faces: Object.fromEntries([...usage.faces].toSorted(([a], [b]) => str(a, b)).map(([id, u]) => [id, face(u, sources.get(id))])),
    pages: Object.fromEntries([...usage.pages].toSorted(([a], [b]) => str(a, b)).map(([p, u]) => [p, {
      private: u.private || undefined,
      visits: [...u.visits].toSorted((a, b) => parseInt(a) - parseInt(b) || str(a, b)),
      faces: Object.fromEntries([...u.faces].toSorted(([a], [b]) => str(a, b)).map(([id, s]) => [id, charsToRanges(s)])),
      fonts: [...u.fonts].toSorted(([a], [b]) => str(a, b)).map(([url, f]) => ({ url, status: f.status, bytes: f.bytes, transfer: f.transfer, sha256: f.sha256, faces: [...f.faces].toSorted(str), initiator: f.initiator })),
      bytes: [...u.fonts.values()].filter((f) => f.status < 400).reduce((n, f) => n + f.bytes, 0),
      preloads: [...u.preloads].toSorted(([a], [b]) => str(a, b)).map(([href, pre]) => ({ href, crossorigin: pre.crossorigin, type: pre.type, used: pre.used })),
      fallback: Object.fromEntries([...u.fallback].toSorted(([a], [b]) => str(a, b)).map(([fam, s]) => [fam, charsToRanges(s)])),
      system: u.system.size ? charsToRanges(u.system) : undefined,
      disagreements: [...u.disagreements].toSorted(str),
      notes: [...u.notes].toSorted(str),
    }])),
    unloaded: Object.fromEntries([...usage.unloaded].toSorted(([a], [b]) => str(a, b))),
    ...extra,
  };
}

/** JSON with keys sorted at every level, undefined dropped, two-space indent, trailing LF. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v).toSorted(str)) { const x = (v as Record<string, unknown>)[k]; if (x !== undefined) o[k] = norm(x); }
      return o;
    }
    return v;
  };
  return JSON.stringify(norm(value), null, 2) + '\n';
}
