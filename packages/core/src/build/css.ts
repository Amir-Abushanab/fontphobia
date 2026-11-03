// The css adapter's writer (§6.1): each @font-face is replaced in place by a marked block of one
// rule per output file. Descriptors are copied as written; only src and unicode-range change (and
// the weight/stretch ranges with limit-axes).
import postcss, { type AtRule } from 'postcss';
import { splitTop, unquote } from '../css/values.ts';

export const beginMarker = (id: string, version: string) => `/* fontphobia:begin ${id} ${version} (generated; rerun \`fontphobia build\`) */`;
export const endMarker = (id: string) => `/* fontphobia:end ${id} */`;

/** The span of entry `id`'s block in `text`, markers included. */
export function findBlock(text: string, id: string): { start: number; end: number } | undefined {
  const b = text.indexOf(`/* fontphobia:begin ${id} `);
  if (b < 0) return undefined;
  const em = endMarker(id);
  const e = text.indexOf(em, b);
  if (e < 0) return undefined;
  return { start: b, end: e + em.length };
}

/** Every block in a text, for `check` and revert sanity checks. */
export function blockIds(text: string): string[] {
  return [...text.matchAll(/\/\* fontphobia:begin (\S+) /g)].map((m) => m[1]!);
}

export interface BlockFile { url: string; unicodeRange: string; /** Tests only (the ext-family mutation). */ family?: string }

/**
 * The marked block replacing `declaration`. `sourceUrl` is the src url that points at the source font;
 * its quoting and format() are kept, with woff2 replacing the container.
 */
export function cssBlock(o: { id: string; version: string; declaration: string; sourceUrl: string; files: BlockFile[]; descriptors?: Record<string, string>; indent: string; eol: string }): string {
  const root = postcss.parse(o.declaration);
  const rule = root.first as AtRule | undefined;
  if (!rule || rule.type !== 'atrule' || rule.name.toLowerCase() !== 'font-face') throw new Error('Not an @font-face rule');
  const srcDecl = rule.nodes?.find((n) => n.type === 'decl' && n.prop.toLowerCase() === 'src');
  if (!srcDecl || srcDecl.type !== 'decl') throw new Error('@font-face has no src');
  const parts = splitTop(srcDecl.value);
  const locals = parts.filter((p) => /^\s*local\(/i.test(p) && !/url\(/i.test(p)).map((p) => p.trim());
  const main = parts.find((p) => { const m = p.match(/url\(\s*(["']?)(.*?)\1\s*\)/i); return m && unquote(m[2]!) === o.sourceUrl; });
  const q = main?.match(/url\(\s*(["'])/i)?.[1] ?? '';
  const fq = main?.match(/format\(\s*(["'])/i)?.[1] ?? q ?? "'";
  const fmt = /variations/i.test(main?.match(/format\(([^)]*)\)/i)?.[1] ?? '') ? 'woff2-variations' : 'woff2';
  const tech = main?.match(/tech\([^)]*\)/i)?.[0];
  const rules = o.files.map((f) => {
    const r = rule.clone();
    const src = [...locals, `url(${q}${f.url}${q}) format(${fq || "'"}${fmt}${fq || "'"})${tech ? ' ' + tech : ''}`].join(', ');
    let hasRange = false;
    r.walkDecls((d) => {
      const p = d.prop.toLowerCase();
      if (p === 'src') d.value = src;
      else if (p === 'font-family' && f.family) d.value = `'${f.family}'`;
      else if (p === 'unicode-range') { d.value = f.unicodeRange; hasRange = true; }
      else if (o.descriptors?.[p] !== undefined) d.value = o.descriptors[p]!;
    });
    if (!hasRange) r.append({ prop: 'unicode-range', value: f.unicodeRange });
    return r.toString().replace(/\r?\n/g, o.eol);
  });
  return [beginMarker(o.id, o.version), ...rules, endMarker(o.id)].join(o.eol + o.indent);
}
