// `nuxt-fonts` (§6.8): @nuxt/fonts, `fonts: { families: [{ name, provider, weights, … }] }` in
// nuxt.config. It resolves every family the CSS names through its providers and rewrites each
// `font-family` stack to add its fallback faces (`Lato, "Lato Fallback: Arial", …`).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { familyKey, parseFamilyList } from '../css/values.ts';
import { listFiles } from '../project/detect.ts';
import { closing, literalProp } from './next-font.ts';

export const NUXT_CONFIGS = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];
export const nuxtConfig = (root: string) => NUXT_CONFIGS.find((f) => existsSync(join(root, f)));

export interface NuxtFontsEntry {
  file: string;
  line: number;
  family: string;
  start: number;
  end: number;
  arg: string;
}

/** Objects in an array literal (`key: [ {…}, {…} ]`), with their byte ranges. */
export function arrayObjects(
  text: string,
  key: string,
): { open: number; close: number; items: { start: number; end: number }[] }[] {
  const out: { open: number; close: number; items: { start: number; end: number }[] }[] = [];
  for (const m of text.matchAll(new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*\\[`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = closing(text, open);
    const items: { start: number; end: number }[] = [];
    for (let i = open + 1; i < close - 1; i++) {
      const c = text[i]!;
      if (c === '"' || c === "'" || c === '`') {
        for (i++; i < close && text[i] !== c; i++) if (text[i] === '\\') i++;
        continue;
      }
      if (c === '[' || c === '(') {
        i = closing(text, i) - 1;
        continue;
      }
      if (c !== '{') continue;
      const e = closing(text, i);
      items.push({ start: i, end: e });
      i = e - 1;
    }
    out.push({ open, close, items });
  }
  return out;
}

export function findNuxtFontsEntries(root: string): NuxtFontsEntry[] {
  const file = nuxtConfig(root);
  if (!file) return [];
  const text = readFileSync(join(root, file), 'utf8');
  const out: NuxtFontsEntry[] = [];
  for (const a of arrayObjects(text, 'families'))
    for (const it of a.items) {
      const arg = text.slice(it.start, it.end);
      const name = literalProp(arg, 'name');
      if (name && !name.array)
        out.push({
          file,
          line: text.slice(0, it.start).split('\n').length,
          family: name.values[0]!,
          start: it.start,
          end: it.end,
          arg,
        });
    }
  return out;
}

export interface FontFamilyDecl {
  file: string;
  start: number;
  end: number;
  value: string;
}

const STYLE = /\.(css|scss|sass|less|pcss|vue)$/i;
const SKIP = new Set(['node_modules', 'public', 'dist', 'build', 'out', '.output', '.nuxt', '.fontphobia']);

/** `font-family` (and `--font-*`) declarations in the project's styles whose stack names `family`. */
export function familyDecls(root: string, family: string): FontFamilyDecl[] {
  const out: FontFamilyDecl[] = [];
  const key = familyKey(family);
  for (const file of listFiles(root, (r) => STYLE.test(r), { skip: (_rel, n) => SKIP.has(n) || n.startsWith('.') })) {
    let text: string;
    try {
      if (statSync(join(root, file)).size > 1_000_000) continue;
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    // @font-face descriptors name a family too; only style rules are stacks. Blank them, keeping offsets.
    text = text.replace(/@font-face\s*\{[^}]*\}/gi, (m) => ' '.repeat(m.length));
    for (const m of text.matchAll(/(?:^|[\s;{])(?:font-family|--font-[\w-]+)\s*:\s*([^;{}\n]+)/g)) {
      const value = m[1]!.replace(/\s*!important\s*$/, '').trimEnd();
      if (!parseFamilyList(value).some((f) => familyKey(f) === key)) continue;
      const start = m.index + m[0].length - m[1]!.length;
      out.push({ file, start, end: start + value.length, value });
    }
  }
  return out;
}
