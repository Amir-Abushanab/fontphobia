// `eject` for `next-font-google` (§6.4) and `astro-fonts` (§6.8): the framework stops fetching the
// family and the project serves it, with the full core/extended/rest split. What the framework
// emitted is copied, not recomputed: its @font-face rules, its fallback faces (exact metrics) and its
// class or custom-property rules come from the build output, so nothing but the font files changes.
// - The sources are the files the framework downloaded from Google (from the build output),
//   committed under .fontphobia/sources/<adapter>/. Slices no page uses are copied as they are.
// - Next: the call becomes an object with the same `className`, `variable` and `style`, which also
//   preloads what Next preloaded that pages use (React's `preload`). Astro: the `fonts[]` entry goes, and each
//   `<Font>` tag becomes an import of the stylesheet plus the preload links it emitted.
// - revert puts each edited snippet back and deletes the generated stylesheet.
import { createHash } from 'node:crypto';
import { KEPT_OUTPUT } from './manifest.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { astroFamily, findAstroFontsEntries, findAstroFontTags } from '../adapters/astro-fonts.ts';
import { closing, findGoogleFontCalls, literalProp } from '../adapters/next-font.ts';
import { arrayObjects, familyDecls, findNuxtFontsEntries, nuxtConfig } from '../adapters/nuxt-fonts.ts';
import { familyKey, parseFamilyList, unquote } from '../css/values.ts';
import { sameFaceDescriptors } from '../css/face-match.ts';
import { listFiles } from '../project/detect.ts';
import type { FacePlan, UsageFileJson } from '../plan/planner.ts';
import { cssBlock } from './css.ts';
import type { Edit } from './edits.ts';
import type { Manifest, ManifestEntry } from './manifest.ts';

export type EjectKind = 'next-font-google' | 'astro-fonts' | 'nuxt-fonts';
export const EJECT_KINDS: readonly EjectKind[] = ['next-font-google', 'astro-fonts', 'nuxt-fonts'];
export const isEjectKind = (k: string | undefined): k is EjectKind => !!k && (EJECT_KINDS as readonly string[]).includes(k);

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const base = (u: string) => posix.basename(u.split(/[?#]/)[0]!);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUTPUT_DIRS = ['out', '.next', 'dist', 'dist/client', 'build', '.output/public'];

/** Files under the build output dirs (the kept output of fontphobia's own build first), by base name. */
function builtFiles(root: string, pred: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of [...OUTPUT_DIRS.map((x) => `${KEPT_OUTPUT}/${x}`), ...OUTPUT_DIRS]) {
    if (!existsSync(join(root, d))) continue;
    for (const rel of listFiles(join(root, d), pred, { skip: (_r, n) => n === 'node_modules' || n === 'cache', max: 100_000 })) {
      const p = `${d}/${rel}`;
      if (!out.has(posix.basename(rel))) out.set(posix.basename(rel), p);
    }
  }
  return out;
}

/** The faces each eject covers: family (as the page names it) → usage face ids. */
function ejectFamilies(usage: UsageFileJson, kind: EjectKind): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, f] of Object.entries(usage.faces)) {
    if (f.source.adapter !== kind) continue;
    const fam = parseFamilyList(f.family)[0] ?? f.family;
    (out.get(fam) ?? out.set(fam, []).get(fam)!).push(id);
  }
  return out;
}

/**
 * The source of each face to eject: the file the framework served (by sha256, in the build output),
 * or the committed copy from an earlier eject. `write`: copies to commit under .fontphobia/sources.
 */
export function ejectSources(root: string, usage: UsageFileJson, prev: Manifest | undefined): { sources: Map<string, { bytes: Uint8Array; file: string }>; write: Map<string, Uint8Array> } {
  const sources = new Map<string, { bytes: Uint8Array; file: string }>();
  const write = new Map<string, Uint8Array>();
  let built: Map<string, string> | undefined;
  for (const kind of EJECT_KINDS) {
    for (const ids of ejectFamilies(usage, kind).values()) {
      for (const id of ids) {
        const f = usage.faces[id]!;
        const want = f.files[0]?.sha256;
        const p = prev?.entries[id];
        if (p && existsSync(join(root, p.source.file))) {
          const bytes = new Uint8Array(readFileSync(join(root, p.source.file)));
          if (sha(bytes) === p.source.sha256) { sources.set(id, { bytes, file: p.source.file }); continue; }
        }
        if (!want || !f.files[0]) continue;
        built ??= builtFiles(root, (r) => /\.(woff2?|ttf|otf)$/i.test(r));
        const at = built.get(base(f.files[0].url));
        if (!at) continue;
        const bytes = new Uint8Array(readFileSync(join(root, at)));
        if (sha(bytes) !== want) continue;
        const file = `.fontphobia/sources/${kind}/${id.replace(/[^\w.-]/g, '-')}${posix.extname(base(f.files[0].url)) || '.woff2'}`;
        sources.set(id, { bytes, file });
        write.set(file, bytes);
      }
    }
  }
  return { sources, write };
}

interface Harvest {
  /** The framework's CSS for the family, normalized: @font-face rules, fallback faces, class or :root rules. */
  css: string;
  /** Base names of the font files it preloaded. */
  preloads: string[];
  /** @nuxt/fonts: the fallback families it adds after the family in every stack. */
  fallbacks?: string[];
}

const fmtRule = (selector: string, decls: [string, string][]) => `${selector} {\n${decls.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}`;
const declsOf = (n: AtRule | Rule): [string, string][] => (n.nodes ?? []).flatMap((d) => (d.type === 'decl' ? [[d.prop, d.value] as [string, string]] : []));

/** next/font/google: the family's rules from the CSS chunks Next emitted. */
function harvestNext(root: string, family: string): Harvest | undefined {
  const css = builtFiles(root, (r) => r.endsWith('.css') && /(^|\/)(_next\/)?static\//.test(r));
  const fams = new Set([familyKey(family), familyKey(`${family} Fallback`)]);
  const faces: string[] = [], classes: string[] = [];
  const seen = new Set<string>();
  for (const p of [...css.values()].sort()) {
    const text = readFileSync(join(root, p), 'utf8');
    if (!text.includes(family)) continue;
    postcss.parse(text).walk((n) => {
      if (n.type === 'atrule' && n.name.toLowerCase() === 'font-face') {
        const d = declsOf(n);
        const fam = d.find(([k]) => k === 'font-family')?.[1];
        if (!fam || !fams.has(familyKey(unquote(fam)))) return;
        const t = fmtRule('@font-face', d);
        if (!seen.has(t)) { seen.add(t); faces.push(t); }
      } else if (n.type === 'rule' && /^\.[\w-]+_(className|variable)$/.test(n.selector)) {
        const d = declsOf(n);
        if (!d.some(([, v]) => v.includes(family))) return;
        const t = fmtRule(n.selector.endsWith('_className') ? '.__className' : '.__variable', d);
        if (!seen.has(t)) { seen.add(t); classes.push(t); }
      }
    });
  }
  // Only Next's own output: its files are under _next/static/media (an ejected build has ours instead).
  if (!faces.some((f) => /url\([^)]*\/media\//.test(f)) || !classes.length) return undefined;
  // Next marks the files it preloads with `.p.` (`<hash>-s.p.<hash>.woff2`).
  const preloads = faces.flatMap((f) => [...f.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => base(m[1]!))).filter((b) => /\.p\./.test(b));
  return { css: [...faces, ...classes].join('\n') + '\n', preloads: [...new Set(preloads)] };
}

/** Astro Fonts API: the family's <style> block from the built HTML, and its preload links. */
function harvestAstro(root: string, hashed: string): Harvest | undefined {
  const html = builtFiles(root, (r) => r.endsWith('.html'));
  for (const p of [...html.values()].sort()) {
    const text = readFileSync(join(root, p), 'utf8');
    if (!text.includes(hashed)) continue;
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      if (!m[1]!.includes(`font-family:${hashed}`) && !m[1]!.includes(`font-family: ${hashed}`)) continue;
      const out: string[] = [];
      const files = new Set<string>();
      postcss.parse(m[1]!).walk((n) => {
        if (n.type === 'atrule' && n.name.toLowerCase() === 'font-face') {
          const d = declsOf(n);
          const fam = unquote(d.find(([k]) => k === 'font-family')?.[1] ?? '');
          if (fam !== hashed && !fam.startsWith(`${hashed} fallback`)) return;
          out.push(fmtRule('@font-face', d));
          for (const u of d.filter(([k]) => k === 'src').flatMap(([, v]) => [...v.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)])) files.add(base(u[1]!));
        } else if (n.type === 'rule' && n.selector === ':root' && declsOf(n).some(([, v]) => v.includes(hashed))) out.push(fmtRule(':root', declsOf(n)));
      });
      if (!out.some((f) => f.includes('/_astro/fonts/'))) continue; // an ejected build: ours, not Astro's
      const preloads = [...text.matchAll(/<link\b[^>]*rel=["']?preload["']?[^>]*>/g)].map((l) => /href=["']([^"']+)["']/.exec(l[0])?.[1]).filter((h): h is string => !!h).map(base).filter((b) => files.has(b));
      return { css: out.join('\n') + '\n', preloads };
    }
  }
  return undefined;
}

/** @nuxt/fonts: the family's rules (faces, fallback faces) from the built HTML or CSS, and the fallback names it adds to stacks. */
function harvestNuxt(root: string, family: string): Harvest | undefined {
  const files = builtFiles(root, (r) => r.endsWith('.html') || (r.endsWith('.css') && r.includes('_nuxt/')));
  const unescape = (v: string) => v.replace(/\\(.)/g, '$1');
  const fallbackOf = (fam: string) => fam.startsWith(`${family} Fallback`);
  for (const p of [...files.values()].sort((a, b) => Number(b.endsWith('.html')) - Number(a.endsWith('.html')) || (a < b ? -1 : 1))) {
    const text = readFileSync(join(root, p), 'utf8');
    if (!text.includes('/_nuxt/fonts/')) continue;
    const chunks = p.endsWith('.html') ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!) : [text];
    for (const css of chunks) {
      const out: string[] = [];
      let fallbacks: string[] | undefined;
      postcss.parse(css).walk((n) => {
        if (n.type === 'atrule' && n.name.toLowerCase() === 'font-face') {
          const d = declsOf(n).map(([k, v]) => [k, k === 'font-family' ? unescape(unquote(v)) : v] as [string, string]);
          const fam = d.find(([k]) => k === 'font-family')?.[1] ?? '';
          if (fam !== family && !fallbackOf(fam)) return;
          out.push(fmtRule('@font-face', d.map(([k, v]) => [k, k === 'font-family' ? JSON.stringify(v) : v])));
        } else if (n.type === 'decl' && (n.prop === 'font-family' || n.prop.startsWith('--font-')) && !fallbacks) {
          const list = n.value.split(',').map((x) => unescape(unquote(x.trim())));
          const i = list.indexOf(family);
          if (i >= 0 && list[i + 1] && fallbackOf(list[i + 1]!)) { fallbacks = []; for (let j = i + 1; j < list.length && fallbackOf(list[j]!); j++) fallbacks.push(list[j]!); }
        }
      });
      if (!out.some((f) => f.includes('/_nuxt/fonts/'))) continue; // an ejected build: ours, not @nuxt/fonts'
      return { css: out.join('\n') + '\n', preloads: [], fallbacks: fallbacks ?? [] };
    }
  }
  return undefined;
}

export interface EjectResult {
  entries: Record<string, ManifestEntry>;
  fonts: Map<string, Uint8Array>;
  edits: Edit[];
  generated: Map<string, string>;
  ejects: NonNullable<Manifest['ejects']>;
  notWritten: { id: string; reason: string }[];
}

export function ejectFramework(root: string, kind: EjectKind, faces: FacePlan[], usage: UsageFileJson, prev: Manifest | undefined, outputs: Map<string, Uint8Array>, sources: Map<string, { bytes: Uint8Array; file: string }>, version: string): EjectResult {
  const r: EjectResult = { entries: {}, fonts: new Map(), edits: [], generated: new Map(), ejects: {}, notWritten: [] };
  // Next and Astro serve public/ at the site root, whether or not the project has one yet.
  const host = { dir: 'public/fonts/fontphobia', url: '/fonts/fontphobia' };
  // Nuxt: under srcDir (app/ in Nuxt 4), reached from nuxt.config's `css` through `~`.
  const genDir = kind === 'nuxt-fonts' ? (existsSync(join(root, 'app')) ? 'app/assets/fontphobia' : 'assets/fontphobia') : existsSync(join(root, 'src')) ? 'src/styles/fontphobia' : 'fontphobia';
  const byFamily = new Map<string, FacePlan[]>();
  for (const f of faces) { const fam = parseFamilyList(usage.faces[f.id]!.family)[0] ?? usage.faces[f.id]!.family; (byFamily.get(fam) ?? byFamily.set(fam, []).get(fam)!).push(f); }
  let built: Map<string, string> | undefined;
  for (const [family, planned] of byFamily) {
    const name = kind === 'astro-fonts' ? astroFamily(family) : family;
    if (kind === 'nuxt-fonts' && familyKey(name).includes(' fallback')) continue;
    const genFile = `${genDir}/${kind}-${slug(name)}.css`;
    const prevEject = prev?.ejects?.[genFile];
    const h: Harvest | undefined = prevEject?.text ? { css: prevEject.text, preloads: prevEject.preloads ?? [], fallbacks: prevEject.fallbacks } : kind === 'next-font-google' ? harvestNext(root, family) : kind === 'astro-fonts' ? harvestAstro(root, family) : harvestNuxt(root, family);
    if (!h) { for (const f of planned) r.notWritten.push({ id: f.id, reason: `couldn't find the CSS ${{ 'next-font-google': 'Next', 'astro-fonts': 'Astro', 'nuxt-fonts': '@nuxt/fonts' }[kind]} emitted for ${name} in the build output; rebuild the site and rerun` }); continue; }

    // The stylesheet: used faces as marked blocks, other slices from copies, fallbacks and classes as emitted.
    const rules = postcss.parse(h.css);
    const urlOf = new Map<string, string>(); // emitted file base name → URL in the ejected CSS
    const copies: string[] = [];
    let out = `/* fontphobia: ejected from ${{ 'next-font-google': `next/font/google (${name})`, 'astro-fonts': `the Astro Fonts API (${name})`, 'nuxt-fonts': `@nuxt/fonts (${name})` }[kind]} (generated; rerun \`fontphobia build\`; \`fontphobia revert\` restores the ${kind === 'next-font-google' ? 'call' : 'config'}) */\n`;
    const done = new Set<string>();
    const nodes = rules.nodes ?? [];
    const className = `fontphobia-${slug(name)}`;
    let classDecls: [string, string][] = [];
    // The emitted file a face came from: its earlier entry's declaration once ejected, else what the audit saw.
    const fileOf = (id: string) => base((prev?.entries[id]?.stylesheet === genFile ? /url\(\s*["']?([^"')]+)/.exec(prev.entries[id]!.declaration)?.[1] : undefined) ?? usage.faces[id]!.files[0]?.url ?? '');
    for (const n of nodes) {
      if (n.type === 'rule') {
        const d = declsOf(n);
        if (n.selector === '.__className') { classDecls = d; out += fmtRule(`.${className}`, d) + '\n'; }
        else if (n.selector === '.__variable') out += fmtRule(`.${className}-variable`, d) + '\n';
        else out += fmtRule(n.selector, d) + '\n';
        continue;
      }
      if (n.type !== 'atrule') continue;
      const text = n.toString();
      const url = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(text)?.[1];
      if (!url) { out += text + '\n'; continue; } // a fallback face: local() only
      const b = base(url);
      const ruleDescriptors = Object.fromEntries(declsOf(n).map(([k, v]) => [k.toLowerCase(), v]));
      const face = planned.find((f) => !done.has(f.id) && fileOf(f.id) === b && sameFaceDescriptors(usage.faces[f.id]!.descriptors, ruleDescriptors));
      if (face?.files) {
        done.add(face.id);
        const placed = face.files.map((f) => ({ f, file: `${host.dir}/${f.name}`, url: `${host.url}/${f.name}` }));
        out += cssBlock({ id: face.id, version, declaration: text, sourceUrl: url, indent: '', eol: '\n', descriptors: face.descriptors, files: [...placed].reverse().map((p) => ({ url: p.url, unicodeRange: p.f.role === 'core' ? undefined : p.f.unicodeRange })) }) + '\n';
        for (const p of placed) r.fonts.set(p.file, outputs.get(p.f.name)!);
        urlOf.set(b, placed.find((p) => p.f.role === 'core')!.url);
        r.entries[face.id] = {
          id: face.id, adapter: kind, family: face.family, stylesheet: genFile, declaration: text,
          source: { file: sources.get(face.id)!.file, sha256: face.source!.sha256, bytes: sources.get(face.id)!.bytes.byteLength },
          outputs: placed.map((p) => ({ role: p.f.role, file: p.file, url: p.url, sha256: p.f.sha256, bytes: p.f.bytes, unicodeRange: p.f.unicodeRange, hintRefs: p.f.hintRefs })),
          plan: { features: face.features, axes: face.axes, descriptors: face.descriptors, hinting: face.hinting, optIns: [...(face.optIns ?? []).filter((x) => x.applied).map((x) => x.id), 'eject'].sort(), rename: face.license?.rename },
        };
        continue;
      }
      // A slice no page uses: served as it is, from a copy.
      const copy = `${host.dir}/${b}`;
      let bytes = existsSync(join(root, copy)) ? new Uint8Array(readFileSync(join(root, copy))) : undefined;
      if (!bytes) { built ??= builtFiles(root, (x) => /\.(woff2?|ttf|otf)$/i.test(x)); const at = built.get(b); if (at) bytes = new Uint8Array(readFileSync(join(root, at))); }
      if (!bytes) { r.notWritten.push({ id: `${name} ${b}`, reason: `${b} isn't in the build output; rebuild the site and rerun` }); continue; }
      r.fonts.set(copy, bytes);
      copies.push(copy);
      urlOf.set(b, `${host.url}/${b}`);
      out += text.replace(url, `${host.url}/${b}`) + '\n';
    }
    for (const f of planned) if (!done.has(f.id)) r.notWritten.push({ id: f.id, reason: `the ${name} CSS no longer lists ${fileOf(f.id) || '?'}; rerun audit` });
    if (!done.size) continue;
    // What the framework preloaded, minus files no page loads (they stay declared and load on demand).
    const usedBases = new Set([...done].map(fileOf));
    const preloads = h.preloads.filter((b) => usedBases.has(b)).map((b) => urlOf.get(b)).filter((u): u is string => !!u);

    // The code: earlier snippets stay as written; a first eject edits the call or the config and tags.
    let snippets = prevEject?.snippets;
    if (!snippets) {
      const s = kind === 'next-font-google' ? nextSnippets(root, name, genFile, className, classDecls, preloads) : kind === 'astro-fonts' ? astroSnippets(root, name, genFile, preloads) : nuxtSnippets(root, name, genFile, h.fallbacks ?? []);
      if (typeof s === 'string') { for (const f of planned) r.notWritten.push({ id: f.id, reason: s }); for (const id of done) delete r.entries[id]; continue; }
      snippets = s.snippets;
      r.edits.push(...s.edits);
    }
    r.generated.set(genFile, out);
    r.ejects[genFile] = { kind, package: name, version: '', specifier: name, css: '', sha256: sha(out), imports: [], snippets, text: h.css, preloads: h.preloads, fallbacks: h.fallbacks?.length ? h.fallbacks : undefined, files: copies.sort() };
  }
  return r;
}

type Snippets = { snippets: { file: string; from: string; to: string }[]; edits: Edit[] } | string;

const relImport = (from: string, to: string) => { const p = posix.relative(posix.dirname(from), to); return p.startsWith('.') ? p : `./${p}`; };

/** next/font/google: the import and call replaced, in one snippet per file (import through call). */
function nextSnippets(root: string, family: string, genFile: string, className: string, classDecls: [string, string][], preloads: string[]): Snippets {
  const calls = findGoogleFontCalls(root).filter((c) => familyKey(c.family) === familyKey(family));
  if (!calls.length) return `couldn't find the ${family}() call from next/font/google`;
  if (calls.length > 1) return `${family} is loaded by ${calls.length} next/font/google calls; eject handles one`;
  const c = calls[0]!;
  const text = readFileSync(join(root, c.file), 'utf8');
  const imp = text.slice(c.importStart, c.importEnd);
  const specs = /\{([^}]*)\}/.exec(imp)![1]!.split(',').map((x) => x.trim()).filter(Boolean).filter((x) => x.split(/\s+as\s+/)[0]!.trim() !== c.name);
  const q = /from\s*(["'])/.exec(imp)?.[1] ?? "'";
  const style = Object.fromEntries(classDecls.map(([k, v]) => [k.replace(/-([a-z])/g, (_m, x: string) => x.toUpperCase()), v]));
  const head = [
    ...(specs.length ? [`import { ${specs.join(', ')} } from ${q}next/font/google${q};`] : []),
    `import ${q}${relImport(c.file, genFile)}${q};`,
    `import { preload as __fontphobiaPreload } from ${q}react-dom${q};`,
    `// fontphobia: ${family} is served from the site (eject); these preload what next/font preloaded that pages use.`,
    `const __fontphobiaFont = (className, variable, style, hrefs) => { const p = () => { for (const href of hrefs) __fontphobiaPreload(href, { as: 'font', type: 'font/woff2', crossOrigin: '' }); }; return { get className() { p(); return className; }, get variable() { p(); return variable; }, style }; };`,
  ].join('\n');
  const shim = `__fontphobiaFont(${JSON.stringify(className)}, ${JSON.stringify(`${className}-variable`)}, ${JSON.stringify(style)}, ${JSON.stringify(preloads)})`;
  // Two snippets (the import, the call), so other edits in the file (a localFont() path) can't overlap.
  const fromImp = text.slice(c.importStart, c.importEnd), fromCall = text.slice(c.callStart, c.callEnd);
  return {
    snippets: [{ file: c.file, from: fromImp, to: head }, { file: c.file, from: fromCall, to: shim }],
    edits: [
      { file: c.file, start: c.importStart, end: c.importEnd, text: head, why: `eject ${family} from next/font/google (import)` },
      { file: c.file, start: c.callStart, end: c.callEnd, text: shim, why: `eject ${family} from next/font/google (call)` },
    ],
  };
}

/** Astro: the fonts[] entry removed from the config; each <Font> tag replaced by the stylesheet import and preloads. */
function astroSnippets(root: string, family: string, genFile: string, preloads: string[]): Snippets {
  const entry = findAstroFontsEntries(root).find((e) => familyKey(e.family) === familyKey(family));
  if (!entry) return `couldn't find the ${family} entry in astro.config's fonts[]`;
  const variable = literalProp(entry.arg, 'cssVariable')?.values[0];
  const cfg = readFileSync(join(root, entry.file), 'utf8');
  const open = cfg.lastIndexOf('[', entry.start);
  const close = closing(cfg, open);
  const arr = cfg.slice(open, close);
  const s = entry.start - open, e = entry.end - open;
  const trail = /^\s*,?\s*/.exec(arr.slice(e))![0];
  const arr2 = (arr.slice(0, s) + arr.slice(e + trail.length)).replace(/,\s*\]$/, ']').replace(/^\[\s*\]$/, '[]');
  const snippets: { file: string; from: string; to: string }[] = [{ file: entry.file, from: arr, to: arr2 }];
  const edits: Edit[] = [{ file: entry.file, start: open, end: close, text: arr2, why: `eject ${family} from astro.config fonts[]` }];
  const tags = findAstroFontTags(root).filter((t) => t.cssVariable === variable);
  if (!tags.length) return `couldn't find a <Font cssVariable="${variable}"> tag`;
  for (const file of [...new Set(tags.map((t) => t.file))].sort()) {
    const text = readFileSync(join(root, file), 'utf8');
    const fm = text.indexOf('---');
    const fmEnd = fm >= 0 ? text.indexOf('\n', fm) + 1 : -1;
    if (fm < 0 || fmEnd <= 0) return `${file} has no frontmatter to import the stylesheet from`;
    // Small snippets that can't overlap other edits (a fontsource import a line below): an inserted
    // import, and each tag replaced by a marked comment plus the preloads it emitted.
    const imp = `import '${relImport(file, genFile)}'; // fontphobia: ${family} is served from the site (eject)\n`;
    snippets.push({ file, from: '', to: imp });
    edits.push({ file, start: fmEnd, end: fmEnd, text: imp, why: `eject ${family}: import the stylesheet` });
    for (const t of tags.filter((x) => x.file === file)) {
      const to = `{/* fontphobia: ejected ${t.text} */}` + (t.preload ? preloads.map((u) => `<link rel="preload" href="${u}" as="font" type="font/woff2" crossorigin />`).join('') : '');
      snippets.push({ file, from: t.text, to });
      edits.push({ file, start: t.start, end: t.end, text: to, why: `eject ${family}: <Font> → preloads` });
    }
  }
  return { snippets, edits };
}

/**
 * @nuxt/fonts: the family set to `provider: 'none'` (so the module leaves it alone), the stylesheet
 * added to `css`, and every stack that names the family given the fallback names the module added.
 */
function nuxtSnippets(root: string, family: string, genFile: string, fallbacks: string[]): Snippets {
  const file = nuxtConfig(root);
  if (!file) return 'no nuxt.config';
  const text = readFileSync(join(root, file), 'utf8');
  const snippets: { file: string; from: string; to: string }[] = [];
  const edits: Edit[] = [];
  const cssPath = `~/${genFile.replace(/^app\//, '')}`;
  const top = /defineNuxtConfig\s*\(\s*\{/.exec(text);
  if (!top) return `${file} has no defineNuxtConfig({ … }) to edit`;
  const topAt = top.index + top[0].length;
  const inserts: string[] = [];
  // The family: provider 'none'.
  const entry = findNuxtFontsEntries(root).find((e) => familyKey(e.family) === familyKey(family));
  if (entry) {
    const p = literalProp(entry.arg, 'provider');
    if (p && !p.array) {
      const to = `${p.quote}none${p.quote}`;
      snippets.push({ file, from: entry.arg, to: entry.arg.slice(0, p.start) + to + entry.arg.slice(p.end) });
      edits.push({ file, start: entry.start, end: entry.end, text: snippets[snippets.length - 1]!.to, why: `eject ${family}: provider 'none'` });
    } else {
      const to = `{ provider: 'none', ${entry.arg.slice(1).trimStart()}`;
      snippets.push({ file, from: entry.arg, to });
      edits.push({ file, start: entry.start, end: entry.end, text: to, why: `eject ${family}: provider 'none'` });
    }
  } else {
    const fam = arrayObjects(text, 'families')[0];
    const item = `{ name: '${family}', provider: 'none' }`;
    if (fam) {
      const ins = `${item}, `;
      snippets.push({ file, from: '', to: ins });
      edits.push({ file, start: fam.open + 1, end: fam.open + 1, text: ins, why: `eject ${family}: provider 'none'` });
    } else inserts.push(`fonts: { families: [${item}] }, // fontphobia: ${family} is served from the site (eject)`);
  }
  // The stylesheet.
  const cssArr = /(?:^|[{,\s])css\s*:\s*\[/.exec(text);
  if (cssArr) {
    const at = cssArr.index + cssArr[0].length;
    const ins = `'${cssPath}', `;
    snippets.push({ file, from: '', to: ins });
    edits.push({ file, start: at, end: at, text: ins, why: `eject ${family}: add the stylesheet` });
  } else inserts.push(`css: ['${cssPath}'], // fontphobia: ${family} is served from the site (eject)`);
  if (inserts.length) {
    const ins = `\n  ${inserts.join('\n  ')}`;
    snippets.push({ file, from: '', to: ins });
    edits.push({ file, start: topAt, end: topAt, text: ins, why: `eject ${family}: config` });
  }
  // Stacks: the fallback names after the family, as @nuxt/fonts added them.
  if (fallbacks.length) {
    const names = fallbacks.map((f) => JSON.stringify(f)).join(', ');
    const fam = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const d of familyDecls(root, family)) {
      if (fallbacks.some((f) => d.value.includes(f))) continue;
      const to = d.value.replace(new RegExp(`((?:^|,)\\s*(["']?)${fam}\\2)(?=\\s*(,|$))`, 'i'), `$1, ${names}`);
      if (to === d.value) continue;
      snippets.push({ file: d.file, from: d.value, to });
      edits.push({ file: d.file, start: d.start, end: d.end, text: to, why: `eject ${family}: keep @nuxt/fonts' fallbacks in the stack` });
    }
  }
  return { snippets, edits };
}

/** Whether any eject of these kinds is in the manifest (later builds keep ejecting). */
export const hasFrameworkEject = (m: Manifest | undefined) => Object.values(m?.ejects ?? {}).some((e) => isEjectKind(e.kind));
