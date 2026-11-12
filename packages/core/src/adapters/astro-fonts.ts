// `astro-fonts` (§6.8): Astro's Fonts API, `fonts: [{ name, cssVariable, provider, weights, … }]` in
// astro.config. Entries are found by bracket matching, string-literal level like next/font.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { listFiles } from '../project/detect.ts';
import { join } from 'node:path';
import { closing, literalProp } from './next-font.ts';

export interface AstroFontsEntry {
  file: string;
  line: number;
  family: string;
  start: number;
  end: number;
  arg: string;
}

const CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs'];

/** Astro emits Fonts API families under a hashed name (`Roboto-4695a571cd365f71`). */
export const astroFamily = (family: string) => family.replace(/^["']|["']$/g, '').replace(/-[0-9a-f]{16}$/, '');

export function findAstroFontsEntries(root: string): AstroFontsEntry[] {
  const out: AstroFontsEntry[] = [];
  for (const file of CONFIGS) {
    if (!existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/(?:^|[{,\s])fonts\s*:\s*\[/g)) {
      const open = m.index + m[0].length - 1;
      const end = closing(text, open);
      for (let i = open + 1; i < end - 1; i++) {
        const c = text[i]!;
        if (c === '"' || c === "'" || c === '`') {
          for (i++; i < end && text[i] !== c; i++) if (text[i] === '\\') i++;
          continue;
        }
        if (c === '[' || c === '(') {
          i = closing(text, i) - 1;
          continue;
        }
        if (c !== '{') continue;
        const e = closing(text, i);
        const arg = text.slice(i, e);
        const name = literalProp(arg, 'name');
        if (name && !name.array)
          out.push({ file, line: text.slice(0, i).split('\n').length, family: name.values[0]!, start: i, end: e, arg });
        i = e - 1;
      }
    }
  }
  return out;
}

export interface AstroFontTag {
  file: string;
  line: number;
  cssVariable: string;
  start: number;
  end: number;
  text: string;
  /** Byte range of `preload` / `preload={true}` inside the tag. */ preload?: { start: number; end: number };
}

/** `<Font cssVariable="--x" preload />` tags in .astro files. */
export function findAstroFontTags(root: string): AstroFontTag[] {
  const out: AstroFontTag[] = [];
  for (const file of listFiles(root, (r) => /\.astro$/i.test(r), {
    skip: (_rel, n) => n === 'node_modules' || n === 'dist' || n.startsWith('.'),
  })) {
    let text: string;
    try {
      if (statSync(join(root, file)).size > 1_000_000) continue;
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('<Font')) continue;
    for (const m of text.matchAll(/<Font\b[^>]*?\/?>/g)) {
      const v = /\bcssVariable\s*=\s*["']([^"']+)["']/.exec(m[0]);
      if (!v) continue;
      const p = /\spreload(?:\s*=\s*\{\s*true\s*\})?(?=[\s/>])/.exec(m[0]);
      out.push({
        file,
        line: text.slice(0, m.index).split('\n').length,
        cssVariable: v[1]!,
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        preload: p ? { start: m.index + p.index + 1, end: m.index + p.index + p[0].length } : undefined,
      });
    }
  }
  return out;
}
