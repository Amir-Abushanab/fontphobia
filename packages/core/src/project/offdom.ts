// Font files used outside the DOM (§7.3): canvas text, FontFace, OG image and PDF generators.
// A static scan; hits are reported, and those files keep working because outputs are new files.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from './detect.ts';

export interface OffDomHit {
  file: string;
  line: number;
  kind: string;
  text: string;
}

const PATTERNS: [string, RegExp][] = [
  ['canvas text', /\b(?:fillText|strokeText)\s*\(|\bctx\.font\s*=|\.font\s*=\s*[`'"][^`'"]*\d+px/],
  ['FontFace', /\bnew\s+FontFace\s*\(|document\.fonts\.add\s*\(/], // document.fonts.load/check: font-checks.ts
  ['OG image', /@vercel\/og|\bsatori\b|\bImageResponse\b|next\/og/],
  ['PDF', /\bpdfkit\b|\bjspdf\b|@react-pdf\/renderer|\bpdf-lib\b|\bpdfmake\b/],
];
const SRC = /\.(m?[jt]sx?|vue|svelte|astro)$/i;
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '_site',
  '.fontphobia',
  'coverage',
]);

export function scanOffDom(root: string): OffDomHit[] {
  const hits: OffDomHit[] = [];
  for (const file of listFiles(root, (r) => SRC.test(r) && !/\.(test|spec|d)\.[mc]?[jt]sx?$/.test(r), {
    skip: (_r, n) => SKIP.has(n) || n.startsWith('.'),
    max: 20_000,
  })) {
    let text: string;
    try {
      if (statSync(join(root, file)).size > 1_000_000) continue;
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const [kind, re] of PATTERNS) {
      const i = lines.findIndex((l) => re.test(l));
      if (i >= 0) hits.push({ file, line: i + 1, kind, text: lines[i]!.trim().slice(0, 120) });
    }
  }
  return hits;
}
