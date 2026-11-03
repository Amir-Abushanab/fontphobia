// `astro-fonts` (§6.8): Astro's Fonts API, `fonts: [{ name, cssVariable, provider, weights, … }]` in
// astro.config. Entries are found by bracket matching, string-literal level like next/font.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closing, literalProp } from './next-font.ts';

export interface AstroFontsEntry { file: string; line: number; family: string; start: number; end: number; arg: string }

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
        if (c === '"' || c === "'" || c === '`') { for (i++; i < end && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
        if (c === '[' || c === '(') { i = closing(text, i) - 1; continue; }
        if (c !== '{') continue;
        const e = closing(text, i);
        const arg = text.slice(i, e);
        const name = literalProp(arg, 'name');
        if (name && !name.array) out.push({ file, line: text.slice(0, i).split('\n').length, family: name.values[0]!, start: i, end: e, arg });
        i = e - 1;
      }
    }
  }
  return out;
}
