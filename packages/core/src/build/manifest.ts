// fontphobia.manifest.json (§9.9): what `build --write` changed, so it can rerun, `revert` and
// `check` (M6). Canonical JSON, committed. No timestamps.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../usage/json.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import type { FacePlan, Role } from '../plan/planner.ts';

export const MANIFEST_FILE = 'fontphobia.manifest.json';
export const MANIFEST_VERSION = 1;

export interface ManifestOutput {
  role: Role;
  /** Repo path of the written font. */
  file: string;
  /** The URL the generated @font-face uses. */
  url: string;
  sha256: string;
  bytes: number;
  unicodeRange: string;
  /** In the cmap but not the unicode-range: the auto-hinter's reference characters. */
  hintRefs?: string;
}

export interface ManifestEntry {
  id: string;
  adapter: 'css' | 'fontsource' | 'google-fonts';
  family: string;
  /** Stylesheet (or component) holding the marked block. */
  stylesheet: string;
  /** The original @font-face text, exactly as it was. `revert` puts it back. */
  declaration: string;
  source: { file: string; sha256: string; bytes: number };
  outputs: ManifestOutput[];
  plan: Pick<FacePlan, 'features' | 'axes' | 'descriptors' | 'hinting'> & { optIns: string[]; rename?: { from: string; to: string } };
  /** Preload hrefs pointed at the core file: `from` is the original text. */
  preloads?: { file: string; from: string; to: string }[];
}

export interface Manifest {
  version: number;
  fontphobia: string;
  harfbuzz: string;
  /** Chrome version of the crawl the plan came from. */
  chrome: string;
  entries: Record<string, ManifestEntry>;
  /**
   * Every other @font-face in the repo when this was built (outside the marked blocks): `check`
   * reports one added, removed or edited since (§12). Hash of the rule text, whitespace collapsed.
   */
  others?: { file: string; family: string; sha256: string }[];
  /**
   * fontsource ejects (§6.2), by generated stylesheet: the package CSS it copies, the imports pointed
   * at it (`from` is the original specifier), and its sha256 (revert deletes it only if unchanged).
   */
  ejects?: Record<string, { kind?: 'fontsource' | 'google'; package: string; version: string; specifier: string; css: string; sha256: string; imports: { file: string; from: string; to: string }[] }>;
  /** Features and axis values the CSS asked for when this was built ("family|feature|tag", "family|axis|wght=700"; family * = any). */
  demands?: string[];
}

export function readManifest(root: string): Manifest | undefined {
  const f = join(root, MANIFEST_FILE);
  if (!existsSync(f)) return undefined;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  if (m.version !== MANIFEST_VERSION) throw new Error(`${MANIFEST_FILE} has version ${m.version}; this fontphobia reads version ${MANIFEST_VERSION}`);
  return m;
}

export const manifestJson = (m: Manifest) => canonicalJson(m);
export function writeManifest(root: string, m: Manifest) { writeFileSync(join(root, MANIFEST_FILE), manifestJson(m)); }

/** Output file name → the entry it belongs to and the original face's descriptors (audit folds them, §M4 notes). */
export function generatedFaces(m: Manifest | undefined): Map<string, { id: string; descriptors: Record<string, string> }> {
  const out = new Map<string, { id: string; descriptors: Record<string, string> }>();
  for (const e of Object.values(m?.entries ?? {})) {
    const rule = parseStylesheet(e.declaration).fontFaces[0];
    if (!rule) continue;
    for (const o of e.outputs) out.set(o.file.split('/').pop()!, { id: e.id, descriptors: rule.descriptors });
  }
  return out;
}
