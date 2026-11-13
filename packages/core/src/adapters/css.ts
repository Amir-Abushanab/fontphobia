// `css` adapter, read-only part (§6.1, M2): find @font-face declarations in the repo, resolve
// their font files, and match live faces to them by file bytes (§6 "Detection").
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseStylesheet, styleBlocks, type FontFaceRule, type Syntax } from '../css/stylesheet.ts';
import { listFiles } from '../project/detect.ts';
import { sha256 } from '../usage/facts.ts';
import type { FaceSource } from '../usage/json.ts';

export interface CssSource {
  file: string;
  line: number;
  rule: FontFaceRule;
  /** src entries resolved to repo files where possible. */
  files: { url: string; path?: string; sha256?: string }[];
  /** Can't be edited automatically (computed URL, indented Sass, Stylus): `manual` (§6.1). */
  manual?: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.fontphobia',
  'dist',
  'build',
  'out',
  '_site',
  '.output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.vercel',
  '.netlify',
  '.turbo',
  '.cache',
  'coverage',
  '.angular',
  '.wrangler',
  '.docusaurus',
  'public/page-data',
]);
const STYLE_EXT = /\.(css|scss|less|pcss|postcss)$/i;
const BLOCK_EXT = /\.(html?|vue|svelte|astro)$/i;
const MANUAL_EXT = /\.(sass|styl|stylus)$/i;
const FONT_EXT = /\.(woff2?|ttf|otf)$/i;
const PUBLIC_DIRS = [
  'public',
  'static',
  'docs/public',
  '.vitepress/public',
  'docs/.vitepress/public',
  'src/public',
  'assets',
  '.',
];

/** `built`: the root is a build output itself, where a directory named `build` or `static` holds real files. */
const skip =
  (outputDirs: string[], built = false) =>
  (rel: string, name: string) =>
    built ? name === 'node_modules' || name.startsWith('.') : skipSource(outputDirs, rel, name);
const skipSource = (outputDirs: string[], rel: string, name: string) =>
  SKIP_DIRS.has(name) ||
  SKIP_DIRS.has(rel) ||
  outputDirs.includes(rel) ||
  rel.endsWith('/.vitepress/dist') ||
  rel.endsWith('/.vitepress/cache') ||
  (name.startsWith('.') && !['.vitepress', '.storybook'].includes(name));

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

function resolveUrl(root: string, file: string, url: string): string | undefined {
  const clean = url.split(/[?#]/)[0]!;
  if (/^(https?:|data:|\/\/)/i.test(clean)) return undefined;
  const cands: string[] = [];
  if (clean.startsWith('/')) for (const d of PUBLIC_DIRS) cands.push(join(root, d, clean));
  else if (clean.startsWith('~')) cands.push(join(root, 'node_modules', clean.slice(1)));
  else {
    cands.push(resolve(dirname(join(root, file)), clean));
    if (!clean.startsWith('.')) cands.push(join(root, 'node_modules', clean));
  }
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function detectCss(root: string, opts: { outputDirs?: string[]; built?: boolean } = {}): CssSource[] {
  const out: CssSource[] = [];
  const files = listFiles(root, (r) => STYLE_EXT.test(r) || BLOCK_EXT.test(r) || MANUAL_EXT.test(r), {
    skip: skip(opts.outputDirs ?? [], opts.built),
  });
  for (const file of files) {
    let text: string;
    try {
      if (statSync(join(root, file)).size > 2_000_000) continue;
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (!/@font-face/i.test(text)) continue;
    if (MANUAL_EXT.test(file)) {
      for (const m of text.matchAll(/@font-face/gi))
        out.push({
          file,
          line: lineAt(text, m.index),
          rule: {
            family: '?',
            src: [],
            unicodeRange: [[0, 0x10ffff]],
            weight: [400, 400],
            style: { kind: 'normal' },
            stretch: [100, 100],
            descriptors: {},
            start: m.index,
            end: m.index,
            line: lineAt(text, m.index),
            wrappers: [],
            computed: true,
          },
          files: [],
          manual: 'indented Sass/Stylus',
        });
      continue;
    }
    const chunks: { text: string; offset: number; syntax: Syntax }[] = BLOCK_EXT.test(file)
      ? styleBlocks(text)
      : [{ text, offset: 0, syntax: /\.scss$/i.test(file) ? 'scss' : /\.less$/i.test(file) ? 'less' : 'css' }];
    for (const c of chunks) {
      const sheet = parseStylesheet(c.text, { syntax: c.syntax });
      for (const rule of sheet.fontFaces) {
        const sources = rule.src
          .filter((s) => s.url !== undefined)
          .map((s) => {
            const path = resolveUrl(root, file, s.url!);
            let h: string | undefined;
            if (path) {
              try {
                h = sha256(new Uint8Array(readFileSync(path)));
              } catch {
                /* unreadable */
              }
            }
            return { url: s.url!, path: path ? relative(root, path).split(sep).join('/') : undefined, sha256: h };
          });
        out.push({
          file,
          line: lineAt(text, c.offset + rule.start),
          rule: { ...rule, start: rule.start + c.offset, end: rule.end + c.offset },
          files: sources,
          manual: rule.computed ? 'computed URL' : undefined,
        });
      }
    }
  }
  return out;
}

/** sha256 → repo path for every font file in the repo and in installed fontsource packages. */
export function indexFontFiles(root: string, opts: { outputDirs?: string[] } = {}): Map<string, string> {
  const index = new Map<string, string>();
  const add = (base: string, rel: string) => {
    try {
      const h = sha256(new Uint8Array(readFileSync(join(base, rel))));
      const p = relative(root, join(base, rel)).split(sep).join('/');
      if (!index.has(h)) index.set(h, p);
    } catch {
      /* unreadable */
    }
  };
  for (const rel of listFiles(root, (r) => FONT_EXT.test(r), { skip: skip(opts.outputDirs ?? []), max: 5000 }))
    add(root, rel);
  for (const scope of ['@fontsource', '@fontsource-variable']) {
    const dir = join(root, 'node_modules', scope);
    for (const rel of listFiles(dir, (r) => /\/files\/[^/]+\.(woff2?|ttf|otf)$/i.test(r), { max: 20_000 }))
      add(dir, rel);
  }
  return index;
}

/** Which adapter (§6) a live face belongs to, from its served bytes and URLs. */
export function classifyFace(
  face: {
    family: string;
    descriptors: Record<string, string>;
    urls: string[];
    files: Map<string, { sha256?: string }>;
    local: boolean;
  },
  css: CssSource[],
  fontIndex: Map<string, string>,
): FaceSource {
  const shas = [...face.files.values()].map((f) => f.sha256).filter((x): x is string => !!x);
  const norm = (v: string | undefined, d: string) => (v ?? d).trim().replace(/\s+/g, ' ').toLowerCase();
  const same = (s: CssSource) =>
    s.rule.family.toLowerCase() === face.family.toLowerCase() &&
    norm(s.rule.descriptors['font-weight'], '400') === norm(face.descriptors['font-weight'], '400') &&
    norm(s.rule.descriptors['font-style'], 'normal') === norm(face.descriptors['font-style'], 'normal') &&
    norm(s.rule.descriptors['unicode-range'], '') === norm(face.descriptors['unicode-range'], '');
  const hits = css.filter((s) => s.files.some((f) => f.sha256 && shas.includes(f.sha256)));
  const s = hits.find(same) ?? hits[0];
  if (s) {
    const hit = s.files.find((f) => f.sha256 && shas.includes(f.sha256))!;
    return { adapter: s.manual ? 'manual' : 'css', file: s.file, line: s.line, fontFile: hit.path, note: s.manual };
  }
  const repo = shas.map((h) => fontIndex.get(h)).find(Boolean);
  // Same-origin URLs are stored as paths (`/_next/static/media/…`): resolve them against any origin.
  const hosts = face.urls
    .map((u) => {
      try {
        return new URL(u, 'http://same-origin.invalid/');
      } catch {
        return undefined;
      }
    })
    .filter((u): u is URL => !!u);
  if (repo?.startsWith('node_modules/@fontsource'))
    return { adapter: 'fontsource', fontFile: repo, note: 'supported from M7' };
  if (hosts.some((u) => u.hostname === 'fonts.gstatic.com')) return { adapter: 'google-fonts' };
  if (hosts.some((u) => /(^|\.)typekit\.net$/.test(u.hostname))) return { adapter: 'adobe-fonts' };
  if (hosts.some((u) => u.pathname.includes('/_next/static/media/')))
    return { adapter: repo ? 'next-font-local' : 'next-font-google', fontFile: repo };
  if (hosts.some((u) => u.pathname.includes('/_astro/fonts/'))) return { adapter: 'astro-fonts' };
  if (hosts.some((u) => u.pathname.includes('/_nuxt/fonts/'))) return { adapter: 'nuxt-fonts' };
  if (face.local) return { adapter: 'manual', note: 'local() font' };
  if (repo)
    return {
      adapter: 'manual',
      fontFile: repo,
      note: 'the file is in the repo but no stylesheet declares it (CSS-in-JS, FontFace, CMS?)',
    };
  return { adapter: 'unknown' };
}
