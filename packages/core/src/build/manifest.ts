// .fontphobia/manifest.json (§9.9): what `build --write` changed, so it can rerun, `revert` and
// `check` (M6). Canonical JSON, committed. No timestamps.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../usage/json.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import { syntaxOf } from './css.ts';
import type { FacePlan, Role } from '../plan/planner.ts';

/** Everything fontphobia writes for itself lives in this folder; only the manifest and sources/ are committed. */
export const FONTPHOBIA_DIR = '.fontphobia';
export const MANIFEST_FILE = '.fontphobia/manifest.json';
/** Where audit keeps the output of a build it ran in a throwaway copy (crawler/isolate.ts), for build to read. */
export const KEPT_OUTPUT = '.fontphobia/output';
/** Where 0.1.x kept the manifest: still read, and moved on the next write. */
export const LEGACY_MANIFEST_FILE = 'fontphobia.manifest.json';
const GITIGNORE = `# fontphobia: everything here is ignored except what revert, check and rebuilds need:
# the manifest (what was changed) and sources/ (the exact source fonts, e.g. as Google served them).
*
!manifest.json
!sources/
!sources/**
`;
const OLD_GITIGNORE = '# fontphobia: visit cache and verify diff images\ncache/\nverify/\n';

/** Create .fontphobia/ with its .gitignore (replacing 0.1.x's, never one you edited). */
export function ensureFontphobiaDir(root: string): string {
  const dir = join(root, FONTPHOBIA_DIR);
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi) || readFileSync(gi, 'utf8') === OLD_GITIGNORE) writeFileSync(gi, GITIGNORE);
  return dir;
}

/** The manifest's path: .fontphobia/manifest.json, or 0.1.x's fontphobia.manifest.json while that's the one present. */
export function manifestPath(root: string): string {
  const now = join(root, MANIFEST_FILE);
  const old = join(root, LEGACY_MANIFEST_FILE);
  return !existsSync(now) && existsSync(old) ? old : now;
}
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
  adapter:
    | 'css'
    | 'fontsource'
    | 'google-fonts'
    | 'next-font-local'
    | 'next-font-google'
    | 'astro-fonts'
    | 'nuxt-fonts';
  family: string;
  /** Stylesheet (or component) holding the marked block. */
  stylesheet: string;
  /** The original @font-face text, exactly as it was. `revert` puts it back. */
  declaration: string;
  source: { file: string; sha256: string; bytes: number };
  outputs: ManifestOutput[];
  plan: Pick<FacePlan, 'features' | 'axes' | 'descriptors' | 'hinting'> & {
    optIns: string[];
    rename?: { from: string; to: string };
  };
  /** next/font/local (§6.3): the `src`/`path` string rewritten in the call (`from` is the original). */
  next?: { file: string; from: string; to: string };
  /** Preload hrefs pointed at the core file: `from` is the original text. */
  preloads?: { file: string; from: string; to: string }[];
}

/** google-fonts tighten (§6.5): a Google stylesheet URL rewritten in place. */
export interface GoogleUrlRecord {
  /** The URL as it was (before any fontphobia build), `&` unescaped. */
  from: string;
  to: string;
  /** Files whose references were rewritten. */
  files: string[];
  dropped: { families: string[]; weights: Record<string, number[]>; axes: Record<string, string[]> };
}

/** next-font-google (§6.4) and astro-fonts (§6.8): a font call's or config entry's options narrowed in place. */
export interface OptionsRecord {
  adapter: 'next-font-google' | 'astro-fonts' | 'nuxt-fonts';
  /** `preload`: an Astro `<Font>` tag's preload filter (the tag text is `from`/`to`). */
  kind?: 'preload';
  file: string;
  family: string;
  /** The call's argument (or config entry) as it was before any fontphobia build, and as written. */
  from: string;
  to: string;
  dropped: { weights: number[]; axes: string[] };
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
  ejects?: Record<
    string,
    {
      kind?: 'fontsource' | 'google' | 'next-font-google' | 'astro-fonts' | 'nuxt-fonts';
      package: string;
      version: string;
      specifier: string;
      css: string;
      sha256: string;
      imports: { file: string; from: string; to: string }[];
      /** google: Google's stylesheet as audited; next/astro: the CSS the framework emitted (later audits no longer see it). */ text?: string;
      /** next/astro eject: code snippets rewritten (`from` is the original; revert swaps it back). */ snippets?: {
        file: string;
        from: string;
        to: string;
      }[];
      /** next/astro eject: base names of the files the framework preloaded. */ preloads?: string[];
      /** next/astro eject: slices no page uses, copied as they are. */ files?: string[];
      /** nuxt eject: the fallback families @nuxt/fonts added to stacks. */ fallbacks?: string[];
    }
  >;
  google?: GoogleUrlRecord[];
  options?: OptionsRecord[];
  /** adobe-fonts --apply-kit (§6.6): each kit's families before the first change (revert sends them back) and as applied. */
  /**
   * `document.fonts.load/check(font)` calls rewritten to wait for the browser's own font loads, so
   * they wait for the files the page uses rather than the core file alone (`from` is the original call).
   */
  fontChecks?: { file: string; from: string; to: string }[];
  kits?: {
    kit: string;
    previous: { id: string; variations: string[]; subset: string }[];
    applied: { id: string; variations: string[]; subset: string }[];
  }[];
  /** Features and axis values the CSS asked for when this was built ("family|feature|tag", "family|axis|wght=700"; family * = any). */
  demands?: string[];
}

export function readManifest(root: string): Manifest | undefined {
  const f = manifestPath(root);
  if (!existsSync(f)) return undefined;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  if (m.version !== MANIFEST_VERSION)
    throw new Error(`${MANIFEST_FILE} has version ${m.version}; this fontphobia reads version ${MANIFEST_VERSION}`);
  return m;
}

export const manifestJson = (m: Manifest) => canonicalJson(m);
export function writeManifest(root: string, m: Manifest, json = manifestJson(m)) {
  ensureFontphobiaDir(root);
  writeFileSync(join(root, MANIFEST_FILE), json);
  rmSync(join(root, LEGACY_MANIFEST_FILE), { force: true });
}

/** Delete the manifest (wherever it is). */
export function removeManifest(root: string) {
  rmSync(join(root, MANIFEST_FILE), { force: true });
  rmSync(join(root, LEGACY_MANIFEST_FILE), { force: true });
  // .fontphobia/ holding nothing but its .gitignore goes too, so revert leaves the project as it found it.
  const dir = join(root, FONTPHOBIA_DIR);
  if (existsSync(dir) && readdirSync(dir).every((n) => n === '.gitignore'))
    rmSync(dir, { recursive: true, force: true });
}

/** Output file name → the entry it belongs to and the original face's descriptors (audit folds them, §M4 notes). */
export function generatedFaces(
  m: Manifest | undefined,
): Map<string, { id: string; descriptors?: Record<string, string> }> {
  const out = new Map<string, { id: string; descriptors?: Record<string, string> }>();
  for (const e of Object.values(m?.entries ?? {})) {
    // next/font/local entries have no rule of ours: the rule Next emits keeps its own descriptors.
    const rule = e.declaration
      ? parseStylesheet(e.declaration, { syntax: syntaxOf(e.stylesheet) }).fontFaces[0]
      : undefined;
    if (e.declaration && !rule) continue;
    for (const o of e.outputs) out.set(o.file.split('/').pop()!, { id: e.id, descriptors: rule?.descriptors });
  }
  return out;
}
