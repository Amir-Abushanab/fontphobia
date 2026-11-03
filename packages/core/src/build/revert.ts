// `revert` (§9): put every original @font-face and preload back from the manifest, byte for byte.
// The generated fonts stay; the result lists them for you to delete.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBlock } from './css.ts';
import { MANIFEST_FILE, readManifest } from './manifest.ts';

export interface RevertResult { files: string[]; fonts: string[]; problems: string[] }

export function revertProject(root: string, o: { write?: boolean } = {}): RevertResult {
  const m = readManifest(root);
  if (!m) throw new Error(`No ${MANIFEST_FILE} in ${root}; nothing to revert`);
  const texts = new Map<string, string>();
  const read = (f: string) => { let t = texts.get(f); if (t === undefined) { t = readFileSync(join(root, f), 'utf8'); texts.set(f, t); } return t; };
  const problems: string[] = [];
  const touched = new Set<string>();
  for (const e of Object.values(m.entries).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!existsSync(join(root, e.stylesheet))) { problems.push(`${e.stylesheet} is gone (${e.id})`); continue; }
    const text = read(e.stylesheet);
    const span = findBlock(text, e.id);
    if (!span) { problems.push(`no fontphobia block for ${e.id} in ${e.stylesheet}`); continue; }
    texts.set(e.stylesheet, text.slice(0, span.start) + e.declaration + text.slice(span.end));
    touched.add(e.stylesheet);
    for (const p of e.preloads ?? []) {
      if (!existsSync(join(root, p.file))) { problems.push(`${p.file} is gone (preload of ${e.id})`); continue; }
      const t = read(p.file);
      const at = t.indexOf(p.to);
      if (at < 0) { problems.push(`preload ${p.to} not found in ${p.file}`); continue; }
      texts.set(p.file, t.slice(0, at) + p.from + t.slice(at + p.to.length));
      touched.add(p.file);
    }
  }
  if (o.write) {
    for (const f of touched) writeFileSync(join(root, f), texts.get(f)!);
    if (!problems.length) unlinkSync(join(root, MANIFEST_FILE));
  }
  const fonts = [...new Set(Object.values(m.entries).flatMap((e) => e.outputs.map((x) => x.file)))].filter((f) => existsSync(join(root, f))).sort();
  return { files: [...touched].sort(), fonts, problems };
}
