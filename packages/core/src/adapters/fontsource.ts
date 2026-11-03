// `fontsource` adapter (§6.2): `import '@fontsource-variable/inter'` and friends. Fontsource ships
// per-script slices, each subset on its own. `build --write` "ejects": it writes the package's CSS
// into the project with each used slice's rule replaced by a marked block pointing at the subsets,
// points the import at that file, and leaves the package installed (the source bytes; `revert`
// points the import back). Slices no page uses keep loading from the package, so unseen text
// renders as before.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { listFiles } from '../project/detect.ts';
import { parseStylesheet } from '../css/stylesheet.ts';

export interface FontsourceImport {
  /** Repo file holding the import. */
  file: string;
  /** Byte range of the specifier inside the quotes. */
  start: number;
  end: number;
  /** `@fontsource-variable/inter` or `@fontsource/inter/400.css`. */
  specifier: string;
}

export interface FontsourcePackage {
  name: string;
  version: string;
  /** Repo path of the package directory (through node_modules). */
  dir: string;
  /** Repo path of the CSS the specifier loads. */
  css: string;
  text: string;
}

const SPEC = /^@fontsource(?:-variable)?\/[a-z0-9][\w.-]*(?:\/[\w./-]+)?$/i;
const CODE_EXT = /\.(m?[jt]sx?|cjs|astro|vue|svelte|mdx|css|scss|less|pcss)$/i;
const SKIP = new Set(['node_modules', '.git', '.fontphobia', 'dist', 'build', 'out', '_site', '.output', '.next', '.nuxt', '.svelte-kit', '.astro', '.vercel', '.netlify', '.turbo', '.cache', 'coverage', '.angular', '.wrangler', '.docusaurus', '.tanstack', '.nitro']);

/** Every import of a fontsource package in the repo's code and styles. */
export function findFontsourceImports(root: string): FontsourceImport[] {
  const out: FontsourceImport[] = [];
  const files = listFiles(root, (r) => CODE_EXT.test(r), { skip: (_rel, n) => SKIP.has(n) || n.startsWith('.') });
  for (const file of files) {
    let text: string;
    try { if (statSync(join(root, file)).size > 1_000_000) continue; text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (!text.includes('@fontsource')) continue;
    // import '…', import x from '…', @import '…', @import url('…'), require('…'), import('…')
    const re = /(?:\bimport\s*(?:[\w*{}\s,$]+\s+from\s*)?|@import\s+(?:url\(\s*)?|\brequire\s*\(\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\1/g;
    for (const m of text.matchAll(re)) {
      const spec = m[2]!;
      if (!SPEC.test(spec)) continue;
      const start = m.index + m[0].length - spec.length - 1;
      out.push({ file, start, end: start + spec.length, specifier: spec });
    }
  }
  return out;
}

/** The package and CSS file a specifier loads, resolved from the importing file. */
export function resolveFontsource(root: string, importer: string, specifier: string): FontsourcePackage | undefined {
  const parts = specifier.split('/');
  const name = parts.slice(0, 2).join('/');
  const sub = parts.slice(2).join('/');
  for (let d = dirname(join(root, importer)); ; d = dirname(d)) {
    const dir = join(d, 'node_modules', name);
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
      const css = join(dir, !sub ? 'index.css' : sub.endsWith('.css') ? sub : `${sub}.css`);
      if (!existsSync(css)) return undefined;
      const rel = (p: string) => relative(root, p).split(sep).join('/');
      return { name, version: pkg.version, dir: rel(dir), css: rel(css), text: readFileSync(css, 'utf8') };
    }
    if (d === root || dirname(d) === d) return undefined;
  }
}

export interface FontsourceRule { start: number; end: number; text: string; url: string; file: string }

/** The package CSS's @font-face rules, with the slice file each loads (repo path). */
export function fontsourceRules(root: string, pkg: FontsourcePackage): FontsourceRule[] {
  const cssDir = posix.dirname(pkg.css);
  return parseStylesheet(pkg.text).fontFaces.flatMap((r) => {
    const url = r.src.find((s) => s.url)?.url;
    if (!url) return [];
    return [{ start: r.start, end: r.end, text: pkg.text.slice(r.start, r.end), url, file: posix.normalize(posix.join(cssDir, url.split(/[?#]/)[0]!)) }];
  });
}

/** Same file, whichever node_modules path names it (pnpm links). */
export function sameFile(root: string, a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(join(root, a)) === realpathSync(join(root, b)); } catch { return false; }
}

/** `@fontsource-variable/inter/wght.css` → `fontsource-variable-inter-wght`. */
export const ejectName = (specifier: string) => specifier.replace(/^@/, '').replace(/\.css$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
