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
import { findSheetRefs, googleCssFromAudit, googleFileUrl, googleSources, hostedDir, isGoogleSheet, sheetSlug } from '../adapters/google.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import { familyKey } from '../css/values.ts';
import { sameFaceDescriptors } from '../css/face-match.ts';
import { findLocalFontCalls, localFontPath, nextFallbackMetrics } from '../adapters/next-font.ts';
import { ejectName, findFontsourceImports, fontsourceRules, resolveFontsource, sameFile, type FontsourcePackage } from '../adapters/fontsource.ts';
import { cssDemands, demandKeys, otherFaces } from './fingerprint.ts';
import { tightenGoogle, type TightenSuggestion } from './google-tighten.ts';
import { narrowOptions, type OptionsSuggestion } from './narrow-options.ts';
import { EJECT_KINDS, ejectFramework, ejectSources, hasFrameworkEject, isEjectKind } from './framework-eject.ts';
import { applyEdits, checkEdits, type Edit } from './edits.ts';
import { MANIFEST_FILE, MANIFEST_VERSION, manifestJson, manifestPath, readManifest, writeManifest, type Manifest, type ManifestEntry } from './manifest.ts';
import { findFontCheckCalls, fontCheckFix } from '../project/font-checks.ts';

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
  /** Stylesheets fontphobia generates (fontsource ejects), repo paths. `exists`: already there with this text. */
  generated: { file: string; bytes: number; exists: boolean }[];
  /** `manual` faces (§6.7): the @font-face block to paste, and where. Their subset files are in `fonts`. */
  snippets: { id: string; file?: string; line?: number; css: string }[];
  /**
   * What the `tighten` opt-in would drop (§6.4, §6.5, §6.8): unused families and weights. Measured and
   * reported, not applied, since a page the audit never saw could ask for one.
   */
  suggestions: (({ kind: 'google' } & TightenSuggestion) | ({ kind: 'options' } & OptionsSuggestion))[];
  /** Planned faces this version can't write yet, with why. */
  notWritten: { id: string; reason: string }[];
  /** Nothing would change. */
  unchanged: boolean;
  /** The edited files' text before this build's edits (for showing the diff after writing). */
  before: Map<string, string>;
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
      // An @font-face src next to a preload (an inline <style> in the same <head>) isn't a preload.
      if (/url\(\s*$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
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

export async function buildProject(root: string, usage: UsageFileJson, cfgIn: PlanConfig, o: ProjectBuildOptions): Promise<BuildResult> {
  const prev = readManifest(root);
  // Once self-hosted, Google faces stay self-hosted on later builds (until `revert`).
  const selfHosted = Object.values(prev?.entries ?? {}).some((e) => e.adapter === 'google-fonts');
  let cfg: PlanConfig = selfHosted && !cfgIn.allow?.includes('self-host') ? { ...cfgIn, allow: [...(cfgIn.allow ?? []), 'self-host'] } : cfgIn;
  // Likewise once next/font/google or Astro fonts were ejected (§6.4, §6.8).
  if (hasFrameworkEject(prev) && !cfg.allow?.includes('eject')) cfg = { ...cfg, allow: [...(cfg.allow ?? []), 'eject'] };
  const sources = await resolveSources(root, usage, { searchDirs: o.searchDirs });
  // self-host (§6.5): the sources are the exact files Google served during the audit.
  const googleProblems = new Map<string, string>();
  if (cfg.allow?.includes('self-host')) {
    const ids = Object.keys(usage.faces).filter((id) => usage.faces[id]!.source.adapter === 'google-fonts' && isGoogleSheet(usage.faces[id]!.sheet));
    const g = await googleSources(root, usage, ids);
    for (const [id, src] of g.sources) sources.set(id, { bytes: src.bytes, file: src.file });
    for (const [id, p] of g.problems) googleProblems.set(id, p);
    // Already self-hosted: the committed copy of Google's file is the source.
    for (const e of Object.values(prev?.entries ?? {})) {
      if (e.adapter !== 'google-fonts' || !usage.faces[e.id] || sources.has(e.id) || !existsSync(join(root, e.source.file))) continue;
      const bytes = new Uint8Array(readFileSync(join(root, e.source.file)));
      if (sha(bytes) === e.source.sha256) sources.set(e.id, { bytes, file: e.source.file });
    }
  }
  // eject (§6.4, §6.8): the sources are the files the framework downloaded, from the build output.
  const ejectWrite = new Map<string, Uint8Array>();
  if (cfg.allow?.includes('eject')) {
    const e = ejectSources(root, usage, prev);
    for (const [id, src] of e.sources) sources.set(id, src);
    for (const [k, v] of e.write) ejectWrite.set(k, v);
  }
  const outputs = new Map<string, Uint8Array>();
  const plan = await planAll(usage, sources, cfg, outputs);
  const css = detectCss(root);
  const preloadFiles = listFiles(root, (r) => TEXT_FOR_PRELOADS.test(r), { skip: (rel, n) => SKIP.has(n) || (n.startsWith('.') && n !== '.vitepress') || rel.endsWith('.vitepress/dist'), max: 20_000 })
    .filter((f) => { try { return statSync(join(root, f)).size < 1_000_000; } catch { return false; } });

  const entries: Record<string, ManifestEntry> = {};
  const fonts = new Map<string, Uint8Array>();
  const edits: Edit[] = [];
  const notWritten: BuildResult['notWritten'] = [];
  const snippets: BuildResult['snippets'] = [];
  const suggestions: BuildResult['suggestions'] = [];
  let calls: ReturnType<typeof findLocalFontCalls> | undefined;
  // One source can back several faces (normal and italic); its preloads go to the face on the most pages.
  const preloadOwner = new Map<string, string>();
  for (const f of [...plan.faces].filter((x) => x.status === 'planned' && x.adapter === 'css').sort((a, b) => (usage.faces[b.id]?.pages.length ?? 0) - (usage.faces[a.id]?.pages.length ?? 0) || (a.id < b.id ? -1 : 1))) {
    const n = posix.basename(f.source!.file);
    if (!preloadOwner.has(n)) preloadOwner.set(n, f.id);
  }

  // fontsource (§6.2): eject the package CSS into the project, with blocks for the used slices.
  const generated = new Map<string, string>();
  const ejects: NonNullable<Manifest['ejects']> = {};
  for (const [id, p] of googleProblems) notWritten.push({ id, reason: p });
  const gFaces = plan.faces.filter((f) => f.status === 'planned' && f.adapter === 'google-fonts');
  if (gFaces.length) {
    const r = await selfHostGoogle(root, gFaces, usage, prev, outputs, sources, o.version);
    Object.assign(entries, r.entries);
    for (const [k, v] of r.fonts) fonts.set(k, v);
    edits.push(...r.edits);
    for (const [k, v] of r.generated) generated.set(k, v);
    Object.assign(ejects, r.ejects);
    notWritten.push(...r.notWritten);
  }
  // next/font/google and Astro fonts ejected to the site (§6.4, §6.8). A slice the eject copied and a
  // page now uses is declared by the generated stylesheet: it's that eject's face, not a css one.
  const ejectSheets = new Map(Object.entries(prev?.ejects ?? {}).filter(([, e]) => isEjectKind(e.kind)).map(([f, e]) => [f, e.kind!]));
  const ejectKindOf = (f: FacePlan) => (isEjectKind(f.adapter) ? f.adapter : f.adapter === 'css' ? ejectSheets.get(usage.faces[f.id]?.source.file ?? '') : undefined);
  const ejectedFamilies = new Set<string>();
  for (const kind of EJECT_KINDS) {
    const fs = plan.faces.filter((f) => f.status === 'planned' && ejectKindOf(f) === kind);
    if (!fs.length) continue;
    const r = ejectFramework(root, kind, fs, usage, prev, outputs, sources, o.version);
    Object.assign(entries, r.entries);
    for (const [k, v] of r.fonts) fonts.set(k, v);
    edits.push(...r.edits);
    for (const [k, v] of r.generated) generated.set(k, v);
    Object.assign(ejects, r.ejects);
    notWritten.push(...r.notWritten);
    for (const e of Object.values(r.entries)) { ejectedFamilies.add(familyKey(e.family)); const src = ejectWrite.get(e.source.file); if (src) fonts.set(e.source.file, src); }
    for (const ej of Object.values(r.ejects)) ejectedFamilies.add(familyKey(ej.package));
  }

  // Google faces staying on Google: tighten the stylesheet URLs (§6.5).
  let google = prev?.google;
  if (!cfg.allow?.includes('self-host')) {
    const t = await tightenGoogle(root, usage, prev, { limitAxes: !!cfg.allow?.includes('limit-axes'), drop: !!cfg.allow?.includes('tighten') });
    suggestions.push(...t.suggestions.map((x) => ({ kind: 'google' as const, ...x })));
    edits.push(...t.edits);
    google = t.records.length ? t.records : undefined;
  }
  // next/font/google calls (§6.4) and Astro fonts[] entries (§6.8): narrow their options.
  const ng = narrowOptions(root, usage, prev, { limitAxes: !!cfg.allow?.includes('limit-axes'), tighten: !!cfg.allow?.includes('tighten'), skip: ejectedFamilies });
  suggestions.push(...ng.suggestions.map((x) => ({ kind: 'options' as const, ...x })));
  edits.push(...ng.edits);
  const options = ng.records.length ? ng.records : undefined;
  const fsFaces = plan.faces.filter((f) => f.status === 'planned' && f.adapter === 'fontsource');
  if (fsFaces.length) {
    const r = ejectFontsource(root, fsFaces, prev, outputs, sources, o.version);
    Object.assign(entries, r.entries);
    for (const [k, v] of r.fonts) fonts.set(k, v);
    edits.push(...r.edits);
    for (const [k, v] of r.generated) generated.set(k, v);
    Object.assign(ejects, r.ejects);
    notWritten.push(...r.notWritten);
  }

  for (const face of plan.faces) {
    if (face.status !== 'planned' || face.adapter === 'fontsource' || face.adapter === 'google-fonts' || ejectKindOf(face)) continue;
    if (face.adapter === 'manual') {
      // §6.7: measured, planned and subset like any face, but the edit is printed, never guessed.
      const u = usage.faces[face.id]!;
      const dir = posix.dirname(face.source!.file);
      const placed = face.files!.map((f) => ({ f, file: `${dir}/${f.name}`, url: `./${f.name}` }));
      for (const p of placed) fonts.set(p.file, outputs.get(p.f.name)!);
      const desc = Object.entries(u.descriptors).filter(([k]) => !['src', 'font-family', 'unicode-range'].includes(k)).map(([k, v]) => `  ${k}: ${v};`).join('\n');
      const declaration = `@font-face {\n  font-family: '${face.family.replace(/'/g, "\\'")}';\n  src: url('${posix.basename(face.source!.file)}');\n${desc ? desc + '\n' : ''}${u.descriptors['unicode-range'] ? `  unicode-range: ${u.descriptors['unicode-range']};\n` : ''}}`;
      const css = cssBlock({ id: face.id, version: o.version, declaration, sourceUrl: posix.basename(face.source!.file), indent: '', eol: '\n', descriptors: face.descriptors, files: [...placed].reverse().map((p) => ({ url: p.url, unicodeRange: p.f.role === 'core' ? undefined : p.f.unicodeRange })) });
      snippets.push({ id: face.id, file: u.source.file, line: u.source.line, css: `${css}\n/* The URLs are relative to ${dir}/; point them at where your site serves these files. */` });
      continue;
    }
    if (face.adapter === 'next-font-local') {
      // §6.3: the one subset file goes next to the source; the call's path string points at it.
      calls ??= findLocalFontCalls(root);
      const p = prev?.entries[face.id];
      const call = calls.find((c) => c.srcs.some((x) => x.file === face.source!.file || (p?.next && x.file === posix.join(posix.dirname(c.file), p.next.to))));
      const src = call?.srcs.find((x) => x.file === face.source!.file || (p?.next && x.path === p.next.to));
      const f = face.files!.find((x) => x.role === 'core');
      if (!call || !src || !f) { notWritten.push({ id: face.id, reason: `couldn't find the localFont() call that loads ${face.source!.file}` }); continue; }
      const out = `${posix.dirname(face.source!.file)}/${f.name}`;
      const to = localFontPath(call, out);
      // Next derives the fallback face from the file; it must come out the same (§6.3).
      const before = nextFallbackMetrics(root, sources.get(face.id)!.bytes), after = nextFallbackMetrics(root, outputs.get(f.name)!);
      if (!before || !after) { notWritten.push({ id: face.id, reason: "couldn't load the project's next to check the fallback face (install dependencies first)" }); continue; }
      if (JSON.stringify(before) !== JSON.stringify(after)) { notWritten.push({ id: face.id, reason: `the fallback face would change (${JSON.stringify(before)} → ${JSON.stringify(after)})` }); continue; }
      fonts.set(out, outputs.get(f.name)!);
      if (src.path !== to) edits.push({ file: call.file, start: src.start, end: src.end, text: to, why: `${face.id}: ${src.path} → ${to}` });
      entries[face.id] = {
        id: face.id, adapter: 'next-font-local', family: face.family, stylesheet: call.file, declaration: '',
        source: { file: face.source!.file, sha256: face.source!.sha256, bytes: sources.get(face.id)!.bytes.byteLength },
        outputs: [{ role: f.role, file: out, url: to, sha256: f.sha256, bytes: f.bytes, unicodeRange: f.unicodeRange, hintRefs: f.hintRefs }],
        plan: { features: face.features, axes: face.axes, descriptors: face.descriptors, hinting: face.hinting, optIns: (face.optIns ?? []).filter((x) => x.applied).map((x) => x.id), rename: face.license?.rename },
        next: { file: call.file, from: p?.next?.from ?? src.path, to },
      };
      continue;
    }
    if (face.adapter !== 'css') { notWritten.push({ id: face.id, reason: `writing ${face.adapter} faces arrives later in M7` }); continue; }
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
      files: [...placed].reverse().map(({ f, at }) => ({ url: (at as { url: string }).url, unicodeRange: f.role === 'core' ? undefined : f.unicodeRange, family: cfg.mutation?.kind === 'ext-family' && cfg.mutation.face === face.id && f.role === 'ext' ? cfg.mutation.family : undefined })),
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

  // Ejects this run didn't touch stay (their entries were kept above).
  for (const [k, v] of Object.entries(prev?.ejects ?? {})) if (!ejects[k] && Object.values(entries).some((e) => e.stylesheet === k)) ejects[k] = v;
  // Font readiness checks in the site's code (§6): once a face is split, `document.fonts.load(font)`
  // and `.check(font)` wait for its core file only. Each also waits for the browser's own font loads
  // (project/font-checks.ts). Earlier fixes are kept for revert; fixed calls are recognized.
  const fontChecks = [...(prev?.fontChecks ?? [])];
  if (Object.keys(entries).length) {
    for (const c of findFontCheckCalls(root)) {
      if (!c.fixable) continue;
      const fix = fontCheckFix(c);
      edits.push({ file: c.file, start: fix.start, end: fix.end, text: fix.text, why: `document.fonts.${c.method}() waits for every font file the page's text needs, not the core file alone` });
      fontChecks.push({ file: c.file, from: c.call, to: fix.text });
    }
  }
  const manifest: Manifest = {
    version: MANIFEST_VERSION, fontphobia: o.version, harfbuzz: harfbuzzVersion(), chrome: usage.meta.chrome, entries,
    ejects: Object.keys(ejects).length ? ejects : undefined, google, options, fontChecks: fontChecks.length ? fontChecks : undefined,
    others: otherFaces(root, css.filter((c) => !generated.has(c.file) && !ejects[c.file]), edits), demands: demandKeys(cssDemands(root)),
  };
  const generatedList = [...generated].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, text]) => ({ file, bytes: Buffer.byteLength(text), exists: existsSync(join(root, file)) && readFileSync(join(root, file), 'utf8') === text }));
  const fontList = [...fonts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, bytes]) => {
    const abs = join(root, file);
    return { file, bytes: bytes.byteLength, exists: existsSync(abs) && sha(readFileSync(abs)) === sha(bytes) };
  });
  const keep = new Set(fonts.keys());
  const stale = Object.values(prev?.entries ?? {}).flatMap((e) => e.outputs).filter((x) => !keep.has(x.file) && !Object.values(entries).some((e) => e.outputs.some((y) => y.file === x.file)))
    .filter((x) => existsSync(join(root, x.file)) && sha(readFileSync(join(root, x.file))) === x.sha256).map((x) => x.file);
  const json = manifestJson(manifest);
  const manifestSame = manifestPath(root) === join(root, MANIFEST_FILE) && existsSync(join(root, MANIFEST_FILE)) && readFileSync(join(root, MANIFEST_FILE), 'utf8') === json;
  const unchanged = !edits.length && fontList.every((f) => f.exists) && generatedList.every((g) => g.exists) && !stale.length && (manifestSame || (!Object.keys(entries).length && !google && !options));

  const before = new Map([...new Set(edits.map((e) => e.file))].map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  checkEdits(edits); // before anything is written, so a conflict leaves the project as it was
  if (o.write && !unchanged) {
    for (const [file, bytes] of fonts) {
      const abs = join(root, file);
      if (existsSync(abs) && sha(readFileSync(abs)) === sha(bytes)) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
    for (const [file, text] of generated) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
    applyEdits(root, edits);
    for (const f of stale) unlinkSync(join(root, f));
    if (Object.keys(entries).length || google || options) writeManifest(root, JSON.parse(json) as Manifest, json);
  }
  return { plan, manifest, fonts: fontList, generated: generatedList, snippets, edits, stale, notWritten, unchanged, suggestions, before };
}

/**
 * fontsource eject (§6.2). For each imported package CSS that declares a planned slice: a generated
 * copy in the project (`src/styles/fontphobia/<package>.css`) whose planned rules are marked blocks
 * pointing at `./files/<outputs>`, and whose other rules point back at the package's files; the
 * imports are pointed at the copy. Rerunning regenerates the copy from the package, so it's idempotent.
 */
function ejectFontsource(root: string, faces: FacePlan[], prev: Manifest | undefined, outputs: Map<string, Uint8Array>, sources: Map<string, { bytes: Uint8Array }>, version: string) {
  const entries: Record<string, ManifestEntry> = {};
  const fonts = new Map<string, Uint8Array>();
  const edits: Edit[] = [];
  const generated = new Map<string, string>();
  const ejects: NonNullable<Manifest['ejects']> = {};
  const notWritten: BuildResult['notWritten'] = [];
  const genDir = existsSync(join(root, 'src')) ? 'src/styles/fontphobia' : 'fontphobia';

  // Candidates: earlier ejects (their imports now point at the copy), then fresh imports.
  type Cand = { specifier: string; pkg: FontsourcePackage; imports: { file: string; start?: number; end?: number; to?: string }[] };
  const cands = new Map<string, Cand>();
  for (const [file, ej] of Object.entries(prev?.ejects ?? {})) {
    const pkg = resolveFontsource(root, ej.imports[0]?.file ?? file, ej.specifier);
    if (pkg) cands.set(ej.specifier, { specifier: ej.specifier, pkg, imports: ej.imports.map((i) => ({ file: i.file, to: i.to })) });
  }
  for (const imp of findFontsourceImports(root)) {
    let c = cands.get(imp.specifier);
    if (!c) { const pkg = resolveFontsource(root, imp.file, imp.specifier); if (!pkg) continue; c = { specifier: imp.specifier, pkg, imports: [] }; cands.set(imp.specifier, c); }
    c.imports.push({ file: imp.file, start: imp.start, end: imp.end });
  }

  const byCand = new Map<string, { face: FacePlan; rule: ReturnType<typeof fontsourceRules>[number] }[]>();
  for (const face of faces) {
    let hit: { spec: string; rule: ReturnType<typeof fontsourceRules>[number] } | undefined;
    for (const c of cands.values()) {
      // The slice file names the rule: italic and normal slices are different files.
      const rule = fontsourceRules(root, c.pkg).find((r) => sameFile(root, r.file, face.source!.file));
      if (rule) { hit = { spec: c.specifier, rule }; break; }
    }
    if (!hit) { notWritten.push({ id: face.id, reason: `couldn't find the import of the fontsource package that loads ${face.source!.file}` }); continue; }
    (byCand.get(hit.spec) ?? byCand.set(hit.spec, []).get(hit.spec)!).push({ face, rule: hit.rule });
  }

  for (const [spec, planned] of byCand) {
    const c = cands.get(spec)!;
    const genFile = `${genDir}/${ejectName(spec)}.css`;
    const filesDir = `${genDir}/files`;
    const rules = fontsourceRules(root, c.pkg);
    let out = `/* fontphobia: ${spec}@${c.pkg.version}, ejected (generated; rerun \`fontphobia build\`; \`fontphobia revert\` restores the import) */\n`;
    let at = 0;
    const toPkg = (u: string, file: string) => posix.relative(genDir, file) + (u.match(/[?#].*$/)?.[0] ?? '');
    for (const r of rules) {
      out += c.pkg.text.slice(at, r.start);
      at = r.end;
      const hit = planned.find((x) => x.rule.start === r.start);
      if (!hit) { out += r.text.replace(r.url, toPkg(r.url, r.file)); continue; }
      const { face } = hit;
      const placed = face.files!.map((f) => ({ f, file: `${filesDir}/${f.name}`, url: `./files/${f.name}` }));
      out += cssBlock({ id: face.id, version, declaration: r.text, sourceUrl: r.url, indent: '', eol: '\n', descriptors: face.descriptors, files: [...placed].reverse().map((p) => ({ url: p.url, unicodeRange: p.f.role === 'core' ? undefined : p.f.unicodeRange })) });
      for (const p of placed) fonts.set(p.file, outputs.get(p.f.name)!);
      entries[face.id] = {
        id: face.id, adapter: 'fontsource', family: face.family, stylesheet: genFile, declaration: r.text,
        source: { file: face.source!.file, sha256: face.source!.sha256, bytes: sources.get(face.id)!.bytes.byteLength },
        outputs: placed.map((p) => ({ role: p.f.role, file: p.file, url: p.url, sha256: p.f.sha256, bytes: p.f.bytes, unicodeRange: p.f.unicodeRange, hintRefs: p.f.hintRefs })),
        plan: { features: face.features, axes: face.axes, descriptors: face.descriptors, hinting: face.hinting, optIns: (face.optIns ?? []).filter((x) => x.applied).map((x) => x.id), rename: face.license?.rename },
      };
    }
    out += c.pkg.text.slice(at);
    generated.set(genFile, out);
    const imports: { file: string; from: string; to: string }[] = [];
    for (const i of c.imports) {
      let rel = posix.relative(posix.dirname(i.file), genFile);
      if (!rel.startsWith('.')) rel = './' + rel;
      if (i.start !== undefined && i.end !== undefined) edits.push({ file: i.file, start: i.start, end: i.end, text: rel, why: `${spec} → ${genFile}` });
      imports.push({ file: i.file, from: spec, to: i.to ?? rel });
    }
    ejects[genFile] = { package: c.pkg.name, version: c.pkg.version, specifier: spec, css: c.pkg.css, sha256: sha(out), imports: imports.sort((a, b) => (a.file < b.file ? -1 : 1)) };
  }
  return { entries, fonts, edits, generated, ejects, notWritten };
}

/**
 * self-host (§6.5): for each Google stylesheet with a planned face, a copy served from the site
 * (`public/fonts/fontphobia/google-<families>.css`): Google's own @font-face rules, the used slices
 * replaced by marked blocks for the subsets next to it, the other slices still loading from Google.
 * Every place the repo names the Google URL is pointed at the copy.
 */
async function selfHostGoogle(root: string, faces: FacePlan[], usage: UsageFileJson, prev: Manifest | undefined, outputs: Map<string, Uint8Array>, sources: Map<string, { bytes: Uint8Array; file: string }>, version: string) {
  const entries: Record<string, ManifestEntry> = {};
  const fonts = new Map<string, Uint8Array>();
  const edits: Edit[] = [];
  const generated = new Map<string, string>();
  const ejects: NonNullable<Manifest['ejects']> = {};
  const notWritten: BuildResult['notWritten'] = [];
  const host = hostedDir(root);
  // Google's sheet and file for each face: from the audit, or from the earlier build once self-hosted.
  const info = new Map<string, { sheet: string; url: string }>();
  for (const f of faces) {
    const p = prev?.entries[f.id];
    const ej = p ? prev?.ejects?.[p.stylesheet] : undefined;
    const sheet = isGoogleSheet(usage.faces[f.id]!.sheet) ? usage.faces[f.id]!.sheet! : ej?.specifier;
    const url = p ? parseStylesheet(p.declaration).fontFaces[0]?.src.find((s) => s.url)?.url : googleFileUrl(usage.faces[f.id]!);
    if (sheet && url) info.set(f.id, { sheet, url }); else notWritten.push({ id: f.id, reason: 'no Google stylesheet recorded for this face' });
  }
  const bySheet = new Map<string, FacePlan[]>();
  for (const f of faces) { const i = info.get(f.id); if (i) (bySheet.get(i.sheet) ?? bySheet.set(i.sheet, []).get(i.sheet)!).push(f); }
  for (const [sheet, planned] of bySheet) {
    // From this audit while it still sees Google's sheet; after self-hosting, as recorded then.
    const prevEject = Object.values(prev?.ejects ?? {}).find((e) => e.specifier === sheet);
    const seen = Object.values(usage.faces).some((f) => f.sheet === sheet);
    const css = seen || !prevEject?.text ? googleCssFromAudit(usage, sheet) : prevEject.text;
    const slug = sheetSlug(sheet);
    const genFile = `${host.dir}/${slug}.css`;
    const rules = parseStylesheet(css).fontFaces;
    let out = `/* fontphobia: self-hosted from ${sheet} (generated; rerun \`fontphobia build\`; \`fontphobia revert\` restores the Google link) */\n`;
    let at = 0;
    const done = new Set<string>();
    for (const r of rules) {
      out += css.slice(at, r.start);
      at = r.end;
      const text = css.slice(r.start, r.end);
      const url = r.src.find((s) => s.url)?.url;
      const face = planned.find((f) => !done.has(f.id) && url && info.get(f.id)!.url === url && sameFaceDescriptors(usage.faces[f.id]?.descriptors ?? parseStylesheet(prev!.entries[f.id]!.declaration).fontFaces[0]!.descriptors, r.descriptors));
      if (!face) { out += text; continue; }
      done.add(face.id);
      const placed = face.files!.map((f) => ({ f, file: `${host.dir}/${f.name}`, url: `./${f.name}` }));
      out += cssBlock({ id: face.id, version, declaration: text, sourceUrl: url!, indent: '', eol: '\n', descriptors: face.descriptors, files: [...placed].reverse().map((p) => ({ url: p.url, unicodeRange: p.f.role === 'core' ? undefined : p.f.unicodeRange })) });
      for (const p of placed) fonts.set(p.file, outputs.get(p.f.name)!);
      entries[face.id] = {
        id: face.id, adapter: 'google-fonts', family: face.family, stylesheet: genFile, declaration: text,
        source: { file: sources.get(face.id)!.file, sha256: face.source!.sha256, bytes: sources.get(face.id)!.bytes.byteLength },
        outputs: placed.map((p) => ({ role: p.f.role, file: p.file, url: p.url, sha256: p.f.sha256, bytes: p.f.bytes, unicodeRange: p.f.unicodeRange, hintRefs: p.f.hintRefs })),
        plan: { features: face.features, axes: face.axes, descriptors: face.descriptors, hinting: face.hinting, optIns: [...(face.optIns ?? []).filter((x) => x.applied).map((x) => x.id), 'self-host'].sort(), rename: face.license?.rename },
      };
    }
    out += css.slice(at);
    for (const f of planned) if (!done.has(f.id)) notWritten.push({ id: f.id, reason: `${sheet} no longer lists ${info.get(f.id)!.url}; rerun audit` });
    if (!done.size) continue;
    generated.set(genFile, out);
    const to = `${host.url}/${slug}.css`;
    const refs = findSheetRefs(root, sheet);
    for (const r of refs) edits.push({ file: r.file, start: r.start, end: r.end, text: to, why: `${sheet} → ${to}` });
    const imports = [...(prevEject?.imports ?? []), ...refs.map((r) => ({ file: r.file, from: r.text, to }))];
    if (!imports.length) for (const f of planned) notWritten.push({ id: f.id, reason: `couldn't find where the repo links ${sheet}` });
    ejects[genFile] = { kind: 'google', package: 'fonts.googleapis.com', version: '', specifier: sheet, css: sheet, sha256: sha(out), imports: imports.sort((a, b) => (a.file < b.file ? -1 : 1)), text: css };
  }
  return { entries, fonts, edits, generated, ejects, notWritten };
}

