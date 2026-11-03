// `build` (§9): plan, then write the subset files, the adapter edits and the manifest together.
// Without `write` it returns the same result without touching anything, for the preview.
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { detectCss, type CssSource } from '../adapters/css.ts';
import { harfbuzzVersion } from '../font/hb.ts';
import { listFiles } from '../project/detect.ts';
import { planAll, type FacePlan, type Plan, type PlanConfig, type UsageFileJson } from '../plan/planner.ts';
import { resolveSources } from '../plan/sources.ts';
import { cssBlock, findBlock } from './css.ts';
import { applyEdits, type Edit } from './edits.ts';
import { MANIFEST_FILE, MANIFEST_VERSION, manifestJson, readManifest, type Manifest, type ManifestEntry } from './manifest.ts';

export interface ProjectBuildOptions {
  version: string;
  write?: boolean;
  /** Extra font directories for resolveSources (tests). */
  searchDirs?: string[];
}

export interface BuildResult {
  plan: Plan;
  manifest: Manifest;
  /** Fonts to write (or written), repo paths. `exists`: already there with these bytes. */
  fonts: { file: string; bytes: number; exists: boolean }[];
  edits: Edit[];
  /** Outputs of an earlier build that nothing references any more (deleted on write). */
  stale: string[];
  /** Planned faces this version can't write yet, with why. */
  notWritten: { id: string; reason: string }[];
  /** Nothing would change. */
  unchanged: boolean;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const TEXT_FOR_PRELOADS = /\.(html?|astro|vue|svelte|[cm]?[jt]sx?|mdx)$/i;
const SKIP = new Set(['node_modules', '.git', '.fontphobia', 'dist', 'build', 'out', '_site', '.output', '.next', '.nuxt', '.svelte-kit', '.astro', '.vercel', '.netlify', '.turbo', '.cache', 'coverage', '.angular', '.wrangler', '.docusaurus', '.tanstack', '.nitro']);

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;

function locate(root: string, face: FacePlan, usage: UsageFileJson, prev: ManifestEntry | undefined, css: CssSource[]): { file: string; start: number; end: number; declaration: string; sourceUrl: string } | string {
  if (prev) {
    const text = readFileSync(join(root, prev.stylesheet), 'utf8');
    const span = findBlock(text, prev.id);
    if (!span) return `the marked block for ${prev.id} is gone from ${prev.stylesheet}; run \`fontphobia revert\` or restore it`;
    return { file: prev.stylesheet, start: span.start, end: span.end, declaration: prev.declaration, sourceUrl: srcUrlFor(prev.declaration, prev.source.file) ?? '' };
  }
  const f = usage.faces[face.id]!;
  const cands = css.filter((s) => s.file === f.source.file && !s.manual && s.files.some((x) => x.path === face.source!.file));
  if (!cands.length) return `couldn't find the @font-face in ${f.source.file ?? 'the repo'} that loads ${face.source!.file}`;
  const best = [...cands].sort((a, b) => Math.abs(a.line - (f.source.line ?? 0)) - Math.abs(b.line - (f.source.line ?? 0)))[0]!;
  const text = readFileSync(join(root, best.file), 'utf8');
  const declaration = text.slice(best.rule.start, best.rule.end);
  if (/fontphobia:begin/.test(text.slice(Math.max(0, best.rule.start - 400), best.rule.start)) && findBlockAround(text, best.rule.start)) return `${best.file}:${best.line} is inside a fontphobia block but the manifest has no entry for it`;
  return { file: best.file, start: best.rule.start, end: best.rule.end, declaration, sourceUrl: best.files.find((x) => x.path === face.source!.file)!.url };
}

function findBlockAround(text: string, at: number): boolean {
  const b = text.lastIndexOf('/* fontphobia:begin ', at);
  const e = text.lastIndexOf('/* fontphobia:end ', at);
  return b > e;
}

/** The src url in a declaration that loads `source` (matched by file name), else the first url. */
function srcUrlFor(declaration: string, source: string): string | undefined {
  const src = /src\s*:([^;]*)/i.exec(declaration)?.[1] ?? '';
  for (const m of src.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const u = m[2]!;
    if (posix.basename(u.split(/[?#]/)[0]!) === posix.basename(source)) return u;
  }
  return /url\(\s*(["']?)(.*?)\1\s*\)/i.exec(src)?.[2];
}

/** Where the outputs go and the URL to reach them: next to the source, at the source URL's directory. */
function placeOutputs(sourceFile: string, sourceUrl: string, name: string): { file: string; url: string } | string {
  if (sourceFile.startsWith('node_modules/')) return `the source font is in node_modules (${sourceFile}); fontphobia doesn't write there`;
  const clean = sourceUrl.split(/[?#]/)[0]!;
  const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/') + 1) : '';
  return { file: posix.join(posix.dirname(sourceFile), name), url: dir + name };
}

/** Preload links that point at `names` (the source or an earlier core file): repoint them at `to`. */
function preloadEdits(root: string, files: string[], names: string[], to: string, id: string): { edits: Edit[]; records: { file: string; from: string; to: string }[] } {
  const edits: Edit[] = [], records: { file: string; from: string; to: string }[] = [];
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(["'\`])((?:[^"'\`\\s]*/)?(?:${alt}))(?:[?#][^"'\`]*)?\\1`, 'g');
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!/preload/i.test(text)) continue;
    for (const m of text.matchAll(re)) {
      const near = text.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300);
      if (!/rel\s*[:=]\s*\{?\s*["'`]preload/i.test(near)) continue;
      const from = m[2]!;
      const next = from.slice(0, from.lastIndexOf('/') + 1) + to;
      if (from === next) continue;
      const start = m.index + 1;
      edits.push({ file, start, end: start + from.length, text: next, why: `preload ${id} → core` });
      records.push({ file, from, to: next });
    }
  }
  return { edits, records };
}

export async function buildProject(root: string, usage: UsageFileJson, cfg: PlanConfig, o: ProjectBuildOptions): Promise<BuildResult> {
  const prev = readManifest(root);
  const sources = await resolveSources(root, usage, { searchDirs: o.searchDirs });
  const outputs = new Map<string, Uint8Array>();
  const plan = await planAll(usage, sources, cfg, outputs);
  const css = detectCss(root);
  const preloadFiles = listFiles(root, (r) => TEXT_FOR_PRELOADS.test(r), { skip: (rel, n) => SKIP.has(n) || (n.startsWith('.') && n !== '.vitepress') || rel.endsWith('.vitepress/dist'), max: 20_000 })
    .filter((f) => { try { return statSync(join(root, f)).size < 1_000_000; } catch { return false; } });

  const entries: Record<string, ManifestEntry> = {};
  const fonts = new Map<string, Uint8Array>();
  const edits: Edit[] = [];
  const notWritten: BuildResult['notWritten'] = [];
  // One source can back several faces (normal and italic); its preloads go to the face on the most pages.
  const preloadOwner = new Map<string, string>();
  for (const f of [...plan.faces].filter((x) => x.status === 'planned' && x.adapter === 'css').sort((a, b) => (usage.faces[b.id]?.pages.length ?? 0) - (usage.faces[a.id]?.pages.length ?? 0) || (a.id < b.id ? -1 : 1))) {
    const n = posix.basename(f.source!.file);
    if (!preloadOwner.has(n)) preloadOwner.set(n, f.id);
  }

  for (const face of plan.faces) {
    if (face.status !== 'planned') continue;
    if (face.adapter !== 'css') { notWritten.push({ id: face.id, reason: face.adapter === 'manual' ? 'manual: fontphobia prints the @font-face to paste (M7)' : `writing ${face.adapter} faces arrives in M7` }); continue; }
    const p = prev?.entries[face.id];
    const loc = locate(root, face, usage, p, css);
    if (typeof loc === 'string') { notWritten.push({ id: face.id, reason: loc }); continue; }
    const placed = face.files!.map((f) => ({ f, at: placeOutputs(face.source!.file, loc.sourceUrl, f.name) }));
    const bad = placed.find((x) => typeof x.at === 'string');
    if (bad) { notWritten.push({ id: face.id, reason: bad.at as string }); continue; }
    const text = readFileSync(join(root, loc.file), 'utf8');
    const ls = lineStart(text, loc.start);
    const indent = /^[ \t]*$/.test(text.slice(ls, loc.start)) ? text.slice(ls, loc.start) : '';
    const block = cssBlock({
      id: face.id, version: o.version, declaration: loc.declaration, sourceUrl: loc.sourceUrl, indent, eol: text.includes('\r\n') ? '\r\n' : '\n',
      descriptors: face.descriptors,
      // Rest, extended, core: WebKit takes a segmented family's primary font (underline skip-ink,
      // emphasis marks) from the last rule; Chrome from the first rule covering U+0020 (M5 notes).
      files: [...placed].reverse().map(({ f, at }) => ({ url: (at as { url: string }).url, unicodeRange: f.unicodeRange, family: cfg.mutation?.kind === 'ext-family' && cfg.mutation.face === face.id && f.role === 'ext' ? cfg.mutation.family : undefined })),
    });
    if (text.slice(loc.start, loc.end) !== block) edits.push({ file: loc.file, start: loc.start, end: loc.end, text: block, why: `${face.id}: ${face.files!.map((f) => f.role).join(' + ')}` });
    for (const { f, at } of placed) fonts.set((at as { file: string }).file, outputs.get(f.name)!);

    // Preloads of the source (or of an earlier core) now load the core file (§9.8).
    const core = placed.find((x) => x.f.role === 'core');
    let preloads = p?.preloads;
    const srcName = posix.basename(face.source!.file);
    if (core && preloadOwner.get(srcName) === face.id) {
      const names = [srcName, ...(p?.outputs.filter((x) => x.role === 'core').map((x) => posix.basename(x.file)) ?? [])];
      const pe = preloadEdits(root, preloadFiles, [...new Set(names)], core.f.name, face.id);
      edits.push(...pe.edits);
      // Keep the original text of preloads repointed by an earlier build.
      const orig = new Map((p?.preloads ?? []).map((r) => [`${r.file}\u0000${r.to}`, r.from]));
      preloads = [...(p?.preloads ?? []).filter((r) => !pe.records.some((x) => x.file === r.file && x.from === r.to)),
        ...pe.records.map((r) => ({ file: r.file, from: orig.get(`${r.file}\u0000${r.from}`) ?? r.from, to: r.to }))];
    }

    const src = sources.get(face.id)!;
    entries[face.id] = {
      id: face.id, adapter: 'css', family: face.family, stylesheet: loc.file, declaration: loc.declaration,
      source: { file: face.source!.file, sha256: face.source!.sha256, bytes: src.bytes.byteLength },
      outputs: placed.map(({ f, at }) => ({ role: f.role, file: (at as { file: string }).file, url: (at as { url: string }).url, sha256: f.sha256, bytes: f.bytes, unicodeRange: f.unicodeRange, hintRefs: f.hintRefs })),
      plan: { features: face.features, axes: face.axes, descriptors: face.descriptors, hinting: face.hinting, optIns: (face.optIns ?? []).filter((x) => x.applied).map((x) => x.id), rename: face.license?.rename },
      preloads: preloads?.length ? preloads : undefined,
    };
  }
  // Entries this run didn't plan (face not in this usage.json) stay as they are.
  for (const [id, e] of Object.entries(prev?.entries ?? {})) if (!entries[id]) entries[id] = e;

  const manifest: Manifest = { version: MANIFEST_VERSION, fontphobia: o.version, harfbuzz: harfbuzzVersion(), chrome: usage.meta.chrome, entries };
  const fontList = [...fonts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, bytes]) => {
    const abs = join(root, file);
    return { file, bytes: bytes.byteLength, exists: existsSync(abs) && sha(readFileSync(abs)) === sha(bytes) };
  });
  const keep = new Set(fonts.keys());
  const stale = Object.values(prev?.entries ?? {}).flatMap((e) => e.outputs).filter((x) => !keep.has(x.file) && !Object.values(entries).some((e) => e.outputs.some((y) => y.file === x.file)))
    .filter((x) => existsSync(join(root, x.file)) && sha(readFileSync(join(root, x.file))) === x.sha256).map((x) => x.file);
  const json = manifestJson(manifest);
  const manifestSame = existsSync(join(root, MANIFEST_FILE)) && readFileSync(join(root, MANIFEST_FILE), 'utf8') === json;
  const unchanged = !edits.length && fontList.every((f) => f.exists) && !stale.length && (manifestSame || !Object.keys(entries).length);

  if (o.write && !unchanged) {
    for (const [file, bytes] of fonts) {
      const abs = join(root, file);
      if (existsSync(abs) && sha(readFileSync(abs)) === sha(bytes)) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
    applyEdits(root, edits);
    for (const f of stale) unlinkSync(join(root, f));
    if (Object.keys(entries).length) writeFileSync(join(root, MANIFEST_FILE), json);
  }
  return { plan, manifest, fonts: fontList, edits, stale, notWritten, unchanged };
}
