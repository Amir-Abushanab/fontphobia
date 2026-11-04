// `fontphobia/vite` (§13): build-time guards that need no HTML. No subsetting, browser or network.
//  - Keeps fontphobia's files out of asset inlining: Vite inlines assets under
//    `build.assetsInlineLimit` (4 KiB) as base64, and a small extended or rest file inlined into
//    the CSS would download on every page.
//  - In dev, warns in the console when text uses a character outside a face's core and extended
//    files: `[fontphobia] "ő" isn't in the Inter subset; rerun fontphobia`.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** What Vite needs from a plugin; typed locally so fontphobia doesn't depend on Vite. */
export interface VitePluginLike {
  name: string;
  enforce?: 'pre' | 'post';
  config?: (config: { root?: string; build?: { assetsInlineLimit?: number | ((file: string, content: Buffer) => boolean | undefined) } }, env: { command: string }) => unknown;
  transformIndexHtml?: { order: 'post'; handler: (html: string) => { tag: string; attrs?: Record<string, string>; children: string; injectTo: 'body' }[] };
}

export interface FontphobiaViteOptions {
  /** Project root holding fontphobia.manifest.json (default: Vite's root, else the working directory). */
  root?: string;
  /** The dev-time character warning (default true). */
  devWarnings?: boolean;
}

export const OUTPUT_NAME = /\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/;
interface ManifestLike { entries: Record<string, { family: string; outputs: { role: string; file: string; unicodeRange: string }[] }> }

function readManifest(root: string): ManifestLike | undefined {
  const f = join(root, 'fontphobia.manifest.json');
  try { return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ManifestLike) : undefined; } catch { return undefined; }
}

/** Is this one of fontphobia's output files (by the manifest, or by its `<stem>.<role>.<hash8>.woff2` name)? */
export function isOutputFile(file: string, manifest?: ManifestLike): boolean {
  const name = basename(file.split(/[?#]/)[0]!);
  if (OUTPUT_NAME.test(name)) return true;
  return !!manifest && Object.values(manifest.entries).some((e) => e.outputs.some((o) => basename(o.file) === name));
}

/** The dev warning script: family (lowercase) → kept code point ranges. */
export function devWarningScript(root: string): string | undefined {
  const m = readManifest(root);
  if (!m) return undefined;
  const fams: Record<string, [number, number][]> = {};
  for (const e of Object.values(m.entries)) {
    const r = (fams[e.family.toLowerCase()] ??= []);
    for (const o of e.outputs) if (o.role !== 'rest') for (const part of o.unicodeRange.split(',')) {
      const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
      if (a) r.push([parseInt(a, 16), parseInt(b ?? a, 16)]);
    }
  }
  for (const r of Object.values(fams)) r.sort((x, y) => x[0] - y[0]);
  return `(() => {
  const F = ${JSON.stringify(fams)};
  const has = (r, c) => { let lo = 0, hi = r.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c < r[m][0]) hi = m - 1; else if (c > r[m][1]) lo = m + 1; else return true; } return false; };
  const warned = new Set();
  const scan = (root) => {
    if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = root.nodeType === 3 ? root : w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement; if (!el) continue;
      const fam = getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
      const r = F[fam]; if (!r) continue;
      for (const ch of n.nodeValue || '') {
        const c = ch.codePointAt(0);
        if (c <= 0x20 || has(r, c) || warned.has(fam + c)) continue;
        warned.add(fam + c);
        console.warn('[fontphobia] "' + ch + '" isn\\'t in the ' + fam + ' subset; rerun fontphobia');
      }
      if (root.nodeType === 3) break;
    }
  };
  const start = () => {
    scan(document.body);
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') scan(m.target); for (const n of m.addedNodes) scan(n); } })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
})();`;
}

export function fontphobia(o: FontphobiaViteOptions = {}): VitePluginLike {
  let root = o.root ? resolve(o.root) : process.cwd();
  let serve = false;
  return {
    name: 'fontphobia',
    enforce: 'post',
    config(config, env) {
      serve = env.command === 'serve';
      if (!o.root && config.root) root = resolve(config.root);
      const manifest = readManifest(root);
      const prev = config.build?.assetsInlineLimit;
      return {
        build: {
          // The function form: false keeps fontphobia's files as files; anything else as before.
          assetsInlineLimit: (file: string, content: Buffer) => {
            if (isOutputFile(file, manifest)) return false;
            if (typeof prev === 'function') return prev(file, content);
            if (typeof prev === 'number') return content.length < prev;
            return undefined;
          },
        },
      };
    },
    transformIndexHtml: {
      order: 'post',
      handler() {
        if (!serve || o.devWarnings === false) return [];
        const code = devWarningScript(root);
        return code ? [{ tag: 'script', attrs: { type: 'module' }, children: code, injectTo: 'body' }] : [];
      },
    },
  };
}

export default fontphobia;
