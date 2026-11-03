// `google-fonts` (§6.5), the `self-host` opt-in. The source of each used face is the exact file Google
// served during the audit (fetched again and checked against the audit's sha256), so self-hosting
// can't change rendering: Google pins the axes a URL leaves out, and an instance made here from the
// google/fonts originals could differ (spike 6). Used slices get the full core/extended/rest split;
// unused slices keep loading from Google, so unseen text renders as before. The stylesheet <link>
// (or head-config `href`) is pointed at a generated stylesheet served from the site.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../project/detect.ts';
import type { UsageFaceJson, UsageFileJson } from '../plan/planner.ts';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const GOOGLE_SOURCES = '.fontphobia/sources/google';
export const isGoogleSheet = (u: string | undefined): u is string => !!u && /^https?:\/\/fonts\.googleapis\.com\/css2?\?/i.test(u);

/** Chrome's user agent for the audited version: Google serves WOFF2 and its unicode-range slices by UA. */
export const chromeUserAgent = (version: string) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

/** The served file of a Google face, as an absolute URL. */
export function googleFileUrl(face: UsageFaceJson): string | undefined {
  const f = face.files[0];
  if (!f) return undefined;
  return f.url.startsWith('http') ? f.url : `https://fonts.gstatic.com${f.url.startsWith('/') ? '' : '/'}${f.url}`;
}

/**
 * Fetch (or reuse) the exact bytes Google served for each face, into .fontphobia/sources/google/
 * (committed: they're the sources of the subsets, and check and verify compare against them).
 */
export async function googleSources(root: string, usage: UsageFileJson, ids: string[]): Promise<{ sources: Map<string, { bytes: Uint8Array; file: string }>; problems: Map<string, string> }> {
  const sources = new Map<string, { bytes: Uint8Array; file: string }>();
  const problems = new Map<string, string>();
  for (const id of ids) {
    const face = usage.faces[id]!;
    const url = googleFileUrl(face);
    const want = face.files[0]?.sha256;
    if (!url || !want) { problems.set(id, 'the audit recorded no file for this face'); continue; }
    // Named by the face (family, weights, style, slice); the audit's sha256 says which bytes.
    const file = `${GOOGLE_SOURCES}/${id.replace(/[^\w.-]/g, '-')}.woff2`;
    const abs = join(root, file);
    let bytes: Uint8Array | undefined;
    if (existsSync(abs)) { const b = new Uint8Array(readFileSync(abs)); if (sha(b) === want) bytes = b; }
    if (!bytes) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': chromeUserAgent(usage.meta.chrome) }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) { problems.set(id, `${url} answered HTTP ${r.status}`); continue; }
        const b = new Uint8Array(await r.arrayBuffer());
        if (sha(b) !== want) { problems.set(id, `Google now serves different bytes for ${url} than during the audit; rerun audit`); continue; }
        mkdirSync(join(root, GOOGLE_SOURCES), { recursive: true });
        writeFileSync(abs, b);
        bytes = b;
      } catch (e) { problems.set(id, `couldn't fetch ${url}: ${(e as Error).message}`); continue; }
    }
    sources.set(id, { bytes, file });
  }
  return { sources, problems };
}

/** The Google stylesheet as Chrome got it. */
export async function googleCss(sheet: string, chrome: string): Promise<string> {
  const r = await fetch(sheet, { headers: { 'user-agent': chromeUserAgent(chrome) }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${sheet} answered HTTP ${r.status}`);
  return r.text();
}

export interface SheetRef { file: string; start: number; end: number; text: string }

const CODE = /\.(html?|astro|vue|svelte|m?[jt]sx?|mdx|css|scss|less)$/i;
const SKIP = new Set(['node_modules', '.git', '.fontphobia', 'dist', 'build', 'out', '_site', '.output', '.next', '.nuxt', '.svelte-kit', '.astro', '.vercel', '.netlify', '.turbo', '.cache', 'coverage', '.angular', '.wrangler', '.docusaurus', '.tanstack', '.nitro', 'public']);

/** Every place the repo names a Google stylesheet URL (raw, or with `&amp;` in HTML). */
export function findSheetRefs(root: string, sheet: string): SheetRef[] {
  const variants = [...new Set([sheet, sheet.replace(/&/g, '&amp;')])];
  const out: SheetRef[] = [];
  for (const file of listFiles(root, (r) => CODE.test(r), { skip: (_rel, n) => SKIP.has(n) || n.startsWith('.') })) {
    let text: string;
    try { if (statSync(join(root, file)).size > 1_000_000) continue; text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (!text.includes('fonts.googleapis.com')) continue;
    for (const v of variants) for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + v.length)) out.push({ file, start: at, end: at + v.length, text: v });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start));
}

/** `css2?family=Fraunces:wght@400..700&family=Inter` → `google-fraunces-inter`. */
export function sheetSlug(sheet: string): string {
  const fams = [...new URL(sheet).searchParams.getAll('family')].map((f) => f.split(':')[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return `google-${fams.join('-') || 'fonts'}`.slice(0, 80);
}

/** Where self-hosted files go and the URL that serves them: `public/` when the project has one. */
export function hostedDir(root: string): { dir: string; url: string } {
  return existsSync(join(root, 'public')) ? { dir: 'public/fonts/fontphobia', url: '/fonts/fontphobia' } : { dir: 'fonts/fontphobia', url: '/fonts/fontphobia' };
}
