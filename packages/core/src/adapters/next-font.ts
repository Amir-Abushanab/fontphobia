// `next-font-local` (§6.3): `localFont({ src })` from `next/font/local`. Detection and edits are
// string-literal level: the call's argument is found by bracket matching (skipping strings and
// comments), and only the `src`/`path` string literals inside it are read or replaced, so the
// user's formatting is never touched.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { listFiles } from '../project/detect.ts';

export interface LocalFontSrc {
  /** Byte range of the path inside its quotes. */
  start: number;
  end: number;
  /** As written in the call. */
  path: string;
  /** Repo path it resolves to (relative to the calling file). */
  file: string;
}

export interface LocalFontCall { file: string; line: number; name: string; srcs: LocalFontSrc[] }

const CODE = /\.(m?[jt]sx?|cjs)$/i;
const SKIP = new Set(['node_modules', '.git', '.fontphobia', '.next', 'out', 'dist', 'build', '.vercel', '.turbo', 'coverage']);

/** The index just past the bracket that closes the one at `open`, skipping strings, templates and comments. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return text.length; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) return text.length; continue; }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i + 1; }
  }
  return text.length;
}

export function findLocalFontCalls(root: string): LocalFontCall[] {
  const out: LocalFontCall[] = [];
  for (const file of listFiles(root, (r) => CODE.test(r), { skip: (_rel, n) => SKIP.has(n) || n.startsWith('.') })) {
    let text: string;
    try { if (statSync(join(root, file)).size > 1_000_000) continue; text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const imp = /import\s+(\w+)\s+from\s*["']next\/font\/local["']/.exec(text);
    if (!imp) continue;
    const name = imp[1]!;
    for (const m of text.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
      const open = m.index + m[0].length - 1;
      const arg = text.slice(open, closing(text, open));
      const srcs: LocalFontSrc[] = [];
      // src: '…' (one file) or path: '…' inside src: [ … ]
      for (const s of arg.matchAll(/\b(src|path)\s*:\s*(["'])([^"'\n]+)\2/g)) {
        const start = open + s.index + s[0].length - s[3]!.length - 1;
        const abs = resolve(dirname(join(root, file)), s[3]!);
        srcs.push({ start, end: start + s[3]!.length, path: s[3]!, file: relative(root, abs).split(sep).join('/') });
      }
      if (srcs.length) out.push({ file, line: text.slice(0, m.index).split('\n').length, name, srcs });
    }
  }
  return out;
}

/** The path to write in place of `src.path` so it points at `output` (both repo paths). */
export function localFontPath(call: LocalFontCall, output: string): string {
  const rel = posix.relative(posix.dirname(call.file), output);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Next's fallback-face metrics for a font file, computed with the project's own Next (§6.3: the
 * fallback face must not change). Undefined when Next or its fontkit can't be loaded.
 */
export function nextFallbackMetrics(root: string, bytes: Uint8Array): Record<string, string> | undefined {
  try {
    const req = createRequire(join(root, 'package.json'));
    // As Next's own local loader does (next/dist/compiled/@next/font/dist/local/loader.js).
    const mod = req('next/dist/compiled/@next/font/dist/fontkit') as { default: unknown };
    const fontFromBuffer = ((mod.default as { default?: unknown }).default ?? mod.default) as (b: Buffer) => unknown;
    const { getFallbackMetricsFromFontFile } = req('next/dist/compiled/@next/font/dist/local/get-fallback-metrics-from-font-file.js') as { getFallbackMetricsFromFontFile(f: unknown, c?: string): Record<string, string> };
    return getFallbackMetricsFromFontFile(fontFromBuffer(Buffer.from(bytes)), 'sans-serif');
  } catch { return undefined; }
}
