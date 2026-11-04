// Finds each face's source font in the repo (by the path the audit matched, checked by sha256)
// and its license files. The one part of planning that reads the file system.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { listFiles } from '../project/detect.ts';
import { toSfnt } from '../font/io.ts';
import { detectLicense } from './license.ts';
import type { SourceFont, UsageFileJson } from './planner.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const FONT = /\.(woff2?|ttf|otf)$/i;

export interface ResolveOptions {
  /** Extra directories to search by sha256 when the recorded path is missing (tests, monorepos). */
  searchDirs?: string[];
}

export async function resolveSources(root: string, usage: UsageFileJson, opts: ResolveOptions = {}): Promise<Map<string, SourceFont>> {
  const out = new Map<string, SourceFont>();
  let index: Map<string, string> | undefined;
  const bySha = (h: string) => {
    if (!index) {
      index = new Map();
      for (const d of opts.searchDirs ?? []) for (const rel of listFiles(d, (r) => FONT.test(r))) {
        const abs = join(d, rel);
        const k = sha(readFileSync(abs));
        if (!index.has(k)) index.set(k, abs);
      }
    }
    return index.get(h);
  };
  for (const [id, f] of Object.entries(usage.faces)) {
    const want = new Set(f.source.sha256 ? [f.source.sha256] : f.files.map((x) => x.sha256).filter(Boolean));
    let abs: string | undefined;
    if (f.source.fontFile) {
      const p = resolve(root, f.source.fontFile);
      if (existsSync(p) && (!want.size || want.has(sha(readFileSync(p))))) abs = p;
    }
    if (!abs) for (const h of want) { abs = bySha(h!); if (abs) break; }
    if (!abs) continue;
    const bytes = new Uint8Array(readFileSync(abs));
    const rel = abs.startsWith(root + sep) ? relative(root, abs).split(sep).join('/') : f.source.fontFile ?? abs;
    out.set(id, { bytes, file: rel, license: detectLicense(await toSfnt(bytes), abs, abs.startsWith(root + sep) ? root : join(abs, '..')) });
  }
  return out;
}
