// `auto`: subset the fonts of a built site inside its output directory. No source file changes, no
// manifest and nothing to commit: the output is subset again on every build.
//
// Two ways to learn what the site uses:
//  - static (no browser): the text of the built HTML and the strings of its scripts. It can't tell
//    which face draws which character, so every face a page could use gets that page's characters,
//    and every OpenType feature is kept.
//  - crawl: a usage.json from an audit of this output, exact per face and per page.
//
// What is written, and why it is safe:
//  - The core, extended and rest files, next to each font in the output.
//  - The split rules, in a <style> at the end of each page's <head>. Rules declared later are
//    checked first, so the split files draw the text. HTML is never cached as immutable, so a page
//    and its font rules always come from the same build. Editing a hashed stylesheet in place would
//    not give that: its name stays the same while its content follows the site's text.
//    They are inline, not a linked stylesheet, because a linked one can arrive after the page's own:
//    until it does, the original rules are the last ones declared, and a style calculation in that
//    window (a script asks for one) starts downloading the original fonts. Measured in Chrome with
//    slow stylesheets: 23 of 480 loads linked, 0 of 576 inline. An inline rule exists as soon as
//    the parser passes it, and a stylesheet that loads later still sits before it in the document.
//  - The original @font-face rules stay, each with a `unicode-range` of the font's own characters
//    added. A page without the split rules (server-rendered, or one this run never saw) still
//    renders from them. With the split rules, no character reaches them, so the original font never
//    downloads. The added range depends on the font alone, so a cached copy stays correct.
//  - A face only a page's own <style> declares is replaced there, and font preloads are pointed at
//    the core file, React preload hints (Next) included.
//  - With the `add-preloads` opt-in and a crawl: a preload of the core file of each face a page
//    draws, where the page has none. Opt-in because it changes what the page loads first, and crawl
//    only because the static mode can't tell which faces a page draws: a preload of a font the page
//    never draws is a wasted download.
//  - With `prefetch-extended` and a crawl: on pages that don't need a face's extended file, a
//    `<link rel="prefetch">` of it, when some other page does. The browser fetches it when idle, so
//    a later page that needs it finds it cached. Every visitor then downloads it once.
//  - With `inline-core` and `rules: 'linked'`: the core file of a face every page draws goes into
//    the linked stylesheet as a data: URL, which saves its request. Linked only: inline rules would
//    put the font in every page's HTML, where it is never cached. A face whose source font a page
//    preloads is left as a file, so that preload keeps something to load.
//    The stylesheet blocks rendering, so what it holds is capped (`inlineCoreMax`), counted over all
//    the faces it embeds, smallest first. What the page loses depends on the face's font-display
//    (measured on the bakery site, 91 KB of cores, 1.6 Mbit/s; spike 13):
//     - block (and auto, the default): text was hidden until the font arrived anyway. Embedded, it
//       showed as soon or sooner (1.31-1.34 s against 1.28-1.45 s), with less layout shift; only
//       the rest of the page painted later. A large allowance, but only when the crawl saw text as
//       every page's largest contentful paint: a hero image that would have painted before the
//       stylesheet arrived waits for it (a 29 KB photo: 0.50 s as files, 1.00 s embedded).
//     - swap, fallback, optional: text painted in a fallback font at 0.40 s; embedded, nothing
//       painted until 1.34 s. A small allowance, and a note for a face embedded anyway.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { detectCss, indexFontFiles, type CssSource } from '../adapters/css.ts';
import { cssBlock } from '../build/css.ts';
import { applyEdits, type Edit } from '../build/edits.ts';
import { MANIFEST_VERSION, readManifest, type Manifest, type ManifestEntry } from '../build/manifest.ts';
import { htmlText, scriptStrings } from '../check/check.ts';
import { sameFaceDescriptors } from '../css/face-match.ts';
import {
  codePointsOf,
  formatUnicodeRange,
  inRanges,
  parseUnicodeRange,
  rangesFromCodePoints,
} from '../css/unicode-range.ts';
import { familyKey } from '../css/values.ts';
import { harfbuzzVersion } from '../font/hb.ts';
import { toSfnt } from '../font/io.ts';
import { detectLicense } from '../plan/license.ts';
import {
  planAll,
  type FacePlan,
  type Plan,
  type PlanConfig,
  type SourceFont,
  type UsageFaceJson,
  type UsageFileJson,
} from '../plan/planner.ts';
import { listFiles } from '../project/detect.ts';
import { kb } from '../report/audit.ts';
import type { FontFacts } from '../usage/capture.ts';
import { fontFacts, sha256 } from '../usage/facts.ts';
import { phraseAround } from '../usage/phrases.ts';
import { verifyStatic, type StaticVerify } from '../verify/static.ts';

export interface AutoOptions {
  /** The project: where licenses next to the source fonts are looked for. */
  root: string;
  /** The built site. Its files are edited in place. */
  outDir: string;
  /** A usage.json from an audit of this output (crawl). Without it the output's text is read (static). */
  usage?: UsageFileJson;
  config?: PlanConfig;
  version: string;
  /** False: plan only, write nothing. */
  write?: boolean;
  /**
   * Where the split rules go. `inline` (default): a <style> at the end of each page's <head>.
   * `linked`: one stylesheet, `fontphobia.<hash8>.css`, at the output's root, linked there instead.
   * It is cached and needs no inline style, but until it arrives the original rules are the last
   * ones declared, and a style calculation in that window downloads the original fonts.
   */
  rules?: 'inline' | 'linked';
  /**
   * `inline-core`: how many bytes of core files the stylesheet may hold, counted over every face
   * embedded. `block`: while only faces with font-display block or auto are in it; `swap`: once a
   * face with swap, fallback or optional is. A number sets both. Default `INLINE_CORE_MAX`.
   */
  inlineCoreMax?: number | { block?: number; swap?: number };
}

/**
 * `inline-core`'s default allowances. `block`: the 91 KB measured on the bakery site, rounded up.
 * `swap`: about 0.1 s of first paint at 1.6 Mbit/s.
 */
export const INLINE_CORE_MAX = { block: 96 * 1024, swap: 16 * 1024 } as const;

/** font-display values that paint text in a fallback font while the font loads. */
const SWAPS = new Set(['swap', 'fallback', 'optional']);

/** Thrown when the written files fail the checks; the output has been put back as it was. */
export class AutoVerifyError extends Error {}

export interface AutoResult {
  mode: 'static' | 'crawl';
  plan: Plan;
  faces: {
    id: string;
    family: string;
    source: string;
    bytes: { now: number; core: number; ext: number; rest: number };
  }[];
  /** Font files written, relative to the output. */
  fonts: { file: string; bytes: number }[];
  /** The split rules added to each page's <head>; absent when every rule was in a page's own <style>. */
  inlined?: { bytes: number };
  /** `rules: 'linked'`: the stylesheet with the split rules. */
  stylesheet?: { file: string; bytes: number };
  /** Pages the split rules were added to. */
  linked: number;
  /** `add-preloads`: the core-file preloads added, and the pages they were added to. */
  preloaded?: { links: number; pages: number };
  /** `prefetch-extended`: the extended files pages prefetch, and the pages that do. */
  prefetched?: { files: number; bytes: number; pages: number };
  /** `inline-core`: the faces whose core file is in the linked stylesheet as a data: URL. */
  embedded?: { id: string; bytes: number }[];
  /** Files of the output that were edited. */
  edited: string[];
  skipped: { id: string; family: string; reason: string }[];
  notes: string[];
  written: boolean;
  /**
   * The deterministic checks `verify` runs, on the files as written (absent on a dry run): every
   * file decodes and validates against its source, the rules keep the original descriptors, and
   * every word shapes the same from the split files as from the source.
   */
  checked?: { outputs: number; words: number; cases: number };
  /** What was written, in the manifest's shape and never saved, with the usage it was planned from: `verify`'s input. */
  manifest: Manifest;
  usage: UsageFileJson;
}

const fmt = (s: Iterable<number>) => formatUnicodeRange(rangesFromCodePoints(s));
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const FONT_EXT = /\.(woff2?|ttf|otf)$/i;
/** Stands for the page that carries an entry's block, and for the path from a page to the output's root, until the pages are read. */
const SHEET = '\u0000sheet';
const ROOT = '\u0001';
const SHEET_NAME = /^fontphobia\.[0-9a-f]{8}\.css$/;
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'font';

// ─── The @font-face rules of the output ─────────────────────────────────────────────────────────

interface DistRule {
  css: CssSource;
  /** The src url that loads the font, as written. */
  url: string;
  /** The font file, relative to the output. */
  path: string;
  sha256: string;
  /** Declared in a page's own <style>. */
  inline: boolean;
}

function distRules(outDir: string): DistRule[] {
  const out: DistRule[] = [];
  const shas = new Map<string, string>();
  const shaOf = (path: string) => {
    let h = shas.get(path);
    if (!h) shas.set(path, (h = sha256(new Uint8Array(readFileSync(join(outDir, path))))));
    return h;
  };
  for (const css of detectCss(outDir, { built: true })) {
    // A rule under @media or @supports can't be declared again outside it.
    if (css.manual || css.rule.wrappers.some((w) => !/^@layer\b/i.test(w))) continue;
    for (const f of css.files) {
      let path = f.path;
      // A site under a base path: `/base/assets/x.woff2` is `assets/x.woff2` in the output.
      if (!path && f.url.startsWith('/')) {
        const segs = f.url.split(/[?#]/)[0]!.split('/').filter(Boolean);
        for (let i = 1; i < segs.length && !path; i++)
          if (isFile(join(outDir, ...segs.slice(i)))) path = segs.slice(i).join('/');
      }
      // The first src a browser can load decides the file.
      if (!path || path.startsWith('..') || !FONT_EXT.test(path)) continue;
      out.push({ css, url: f.url, path, sha256: shaOf(path), inline: /\.html?$/i.test(css.file) });
      break;
    }
  }
  return out;
}

// ─── Static usage: what the built text can say without a browser ────────────────────────────────

const TEXT_FILE = /\.(html?|m?js|json|css)$/i;
const MAX_WORDS = 50_000;
/** A built HTML file as the page key an audit gives it ("/about/"). */
const pageKey = (rel: string) => {
  const p = '/' + rel.split(sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
};
const drawable = (cp: number) => cp >= 0x20 && !(cp >= 0x7f && cp < 0xa0);

interface Group {
  id: string;
  rules: DistRule[];
}

async function staticUsage(
  outDir: string,
  rules: DistRule[],
  version: string,
): Promise<{ usage: UsageFileJson; groups: Group[]; skipped: AutoResult['skipped'] }> {
  const pages = new Map<string, Set<number>>();
  const all = new Set<number>();
  /** Characters of script strings: kept, but on no page, so they never weigh on the choice of core. */
  const scripted = new Set<number>();
  const words = new Set<string>();
  const locales = new Set<string>();
  const families = new Set(rules.map((r) => r.css.rule.family.toLowerCase()));
  const named = new Set<string>();
  let editable = false;
  let lists = false;
  let truncated = false;
  const addWords = (text: string) => {
    const keep = (w: string) => {
      if (words.size >= MAX_WORDS) truncated = true;
      else words.add(w);
    };
    const tokens = text.split(/\s+/).filter(Boolean);
    tokens.forEach((w, k) => {
      // Only a word with a character outside ASCII can end up split between two files.
      // eslint-disable-next-line no-control-regex -- anything outside ASCII
      if (/[^\x00-\x7f]/.test(w)) keep(w);
      // A word of symbols only, with its neighbours (usage/phrases.ts).
      const phrase = phraseAround(tokens[k - 1], w, tokens[k + 1]);
      if (phrase) keep(phrase);
    });
  };
  const files = listFiles(outDir, (r) => TEXT_FILE.test(r), {
    skip: (_rel, n) => n === 'node_modules' || n.startsWith('.'),
    max: 20_000,
  });
  for (const rel of files) {
    let text: string;
    try {
      if (statSync(join(outDir, rel)).size > 5_000_000) continue;
      text = readFileSync(join(outDir, rel), 'utf8');
    } catch {
      continue;
    }
    // A family counts as used when something other than its own @font-face names it.
    if (named.size < families.size) {
      const rest = text.replace(/@font-face\s*\{[^}]*\}/gi, ' ').toLowerCase();
      for (const f of families) if (!named.has(f) && rest.includes(f)) named.add(f);
    }
    if (/\.css$/i.test(rel)) continue;
    if (/\.html?$/i.test(rel)) {
      const visible = htmlText(text);
      const chars = new Set<number>();
      for (const ch of visible) {
        const c = ch.codePointAt(0)!;
        if (drawable(c)) chars.add(c);
      }
      for (const c of chars) all.add(c);
      pages.set(pageKey(rel), chars);
      addWords(visible);
      for (const m of text.matchAll(/\blang\s*=\s*["']?([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*)/g)) locales.add(m[1]!);
      editable ||= /<(input|textarea)\b|\bcontenteditable\b/i.test(text);
      lists ||= /<li\b/i.test(text);
    } else {
      const strings = scriptStrings(text);
      for (const ch of strings) {
        const c = ch.codePointAt(0)!;
        if (drawable(c)) scripted.add(c);
      }
      addWords(strings);
    }
  }
  // `text-transform` can draw the other case of any letter.
  for (const c of [...all, ...scripted]) {
    if (c < 0x80) continue;
    const ch = String.fromCodePoint(c);
    for (const v of ch.toUpperCase() + ch.toLowerCase()) scripted.add(v.codePointAt(0)!);
  }
  const used = new Set([...all, ...scripted]);

  // One face per family, descriptors and font file; the same rule in several stylesheets is one face.
  const byKey = new Map<string, DistRule[]>();
  for (const r of rules) {
    const d = r.css.rule.descriptors;
    const key = [
      familyKey(r.css.rule.family),
      d['font-weight'] ?? '',
      d['font-style'] ?? '',
      d['font-stretch'] ?? '',
      d['unicode-range'] ?? '',
      r.sha256,
    ]
      .map((x) => x.trim().replace(/\s+/g, ' ').toLowerCase())
      .join('\u0000');
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const facts = new Map<string, FontFacts | Error>();
  const faces: Record<string, UsageFaceJson> = {};
  const groups: Group[] = [];
  const skipped: AutoResult['skipped'] = [];
  const ids = new Set<string>();
  const drawsOf = new Map<string, (c: number) => boolean>();
  const pageKeys = [...pages.keys()].toSorted();
  for (const rs of [...byKey.values()].toSorted((a, b) => (a[0]!.css.file < b[0]!.css.file ? -1 : 1))) {
    const r = rs[0]!;
    const rule = r.css.rule;
    const base = [
      slug(rule.family),
      (rule.descriptors['font-weight'] ?? '400').trim().replace(/\s+/g, '-'),
      slug(rule.descriptors['font-style'] ?? 'normal'),
    ].join('-');
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    const bytes = new Uint8Array(readFileSync(join(outDir, r.path)));
    let f = facts.get(r.sha256);
    if (!f) {
      try {
        f = await fontFacts(bytes);
      } catch (e) {
        f = e as Error;
      }
      facts.set(r.sha256, f);
    }
    if (f instanceof Error) {
      skipped.push({ id, family: rule.family, reason: `${r.path} couldn't be read as a font: ${f.message}` });
      continue;
    }
    if (!named.has(rule.family.toLowerCase())) {
      skipped.push({ id, family: rule.family, reason: 'nothing in the output names this family' });
      continue;
    }
    // A face draws only what its file has and its `unicode-range` lets through: the rest of a page's
    // text goes to another face of the family (a Fontsource slice) or to a fallback font.
    const cmap = f.cmap;
    const draws = (c: number) => cmap.has(c) && inRanges(rule.unicodeRange, c);
    const mine = new Set([...used].filter(draws));
    if (!mine.size) {
      skipped.push({ id, family: rule.family, reason: 'no text in the output has a character of this face' });
      continue;
    }
    // A word is shaped per face, in the runs this face draws.
    const runs = new Set<string>();
    for (const w of words) {
      let run = '';
      let wide = false;
      const flush = () => {
        if (run && wide) runs.add(run);
        run = '';
        wide = false;
      };
      for (const ch of w) {
        const c = ch.codePointAt(0)!;
        if (!draws(c)) flush();
        else {
          run += ch;
          wide ||= c > 0x7f;
        }
      }
      flush();
    }
    const { src: _src, 'font-family': _family, ...descriptors } = rule.descriptors;
    faces[id] = {
      family: rule.family,
      descriptors,
      source: { adapter: 'css', file: r.css.file, line: r.css.line, fontFile: r.path },
      files: [{ url: r.url, sha256: r.sha256, bytes: bytes.byteLength }],
      chars: fmt(mine),
      count: mine.size,
      inserted: lists ? { 'list markers': 'U+2022,U+25AA,U+25E6' } : {},
      // Shaped at both ends of every axis: the pages' own axis values aren't known.
      contexts: [
        { features: '', axes: Object.fromEntries(f.axes.map((a) => [a.tag, [a.min, a.max]])), words: [...runs] },
      ],
      rendered: {},
      declared: {},
      // Which features the pages turn on isn't known either: all of the font's are kept.
      features: [...f.features].toSorted(),
      editable: editable || undefined,
      wordsTruncated: truncated || undefined,
      locales: [...locales].toSorted(),
      pages: pageKeys.filter((k) => [...pages.get(k)!].some(draws)),
    };
    drawsOf.set(id, draws);
    groups.push({ id, rules: rs });
  }
  const faceIds = Object.keys(faces);
  const usagePages: UsageFileJson['pages'] = {};
  for (const [key, chars] of pages) {
    const drawn = faceIds.flatMap((id) => {
      const on = [...chars].filter(drawsOf.get(id)!);
      return on.length ? [[id, fmt(on)] as const] : [];
    });
    usagePages[key] = { faces: Object.fromEntries(drawn), bytes: 0, fonts: [] };
  }
  return {
    usage: {
      version: 1,
      meta: {
        fontphobia: version,
        harfbuzz: harfbuzzVersion(),
        chrome: '',
        framework: 'static',
        mode: 'static',
        viewports: [],
        fontSizes: [],
      },
      faces,
      pages: usagePages,
    },
    groups,
    skipped,
  };
}

/** A crawl's faces, matched to the output's rules by font bytes, family and descriptors. */
function crawlGroups(
  usage: UsageFileJson,
  rules: DistRule[],
): { usage: UsageFileJson; groups: Group[]; skipped: AutoResult['skipped'] } {
  const faces: Record<string, UsageFaceJson> = {};
  const groups: Group[] = [];
  const skipped: AutoResult['skipped'] = [];
  for (const [id, f] of Object.entries(usage.faces)) {
    const skip = (reason: string) => skipped.push({ id, family: f.family, reason });
    if (f.local) {
      skip('drawn from an installed font (local())');
      continue;
    }
    const shas = new Set([f.source.sha256, ...f.files.map((x) => x.sha256)].filter(Boolean));
    const bySha = rules.filter((r) => shas.has(r.sha256));
    const same = bySha.filter(
      (r) =>
        familyKey(r.css.rule.family) === familyKey(f.family) &&
        sameFaceDescriptors(f.descriptors, r.css.rule.descriptors),
    );
    if (!same.length) {
      skip(
        bySha.length
          ? 'no @font-face in the output has its family and descriptors'
          : 'no stylesheet in the output declares its font file (another origin serves it, or a script declares it)',
      );
      continue;
    }
    // Whatever framework declared it, in the output it is a plain rule and a file.
    faces[id] = { ...f, source: { ...f.source, adapter: 'css' } };
    groups.push({ id, rules: same });
  }
  return { usage: { ...usage, faces }, groups, skipped };
}

// ─── Pages ──────────────────────────────────────────────────────────────────────────────────────

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

/**
 * What to put before a path relative to the output's root so this page reaches it, taken from a
 * file the page already loads (which knows the site's base path). Else `../` per directory level.
 */
function hrefPrefix(outDir: string, rel: string, html: string): string {
  const based = /<base\b/i.test(html);
  const here = dirname(join(outDir, rel));
  let n = 0;
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*>/gi)) {
    if (++n > 40) break;
    const v = (attr(m[0], 'href') ?? attr(m[0], 'src'))?.split(/[?#]/)[0];
    if (!v || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(v)) continue;
    const segs = v.split('/');
    for (let i = 0; i < segs.length; i++) {
      const tail = segs.slice(i);
      if (tail.some((s) => s === '' || s === '.' || s === '..')) continue;
      const file = join(outDir, ...tail);
      if (!isFile(file)) continue;
      // A relative reference has to be that same file, not one of the same name further down.
      if (!v.startsWith('/') && !based && resolve(here, v) !== file) continue;
      return v.slice(0, v.length - tail.join('/').length);
    }
  }
  return '../'.repeat(rel.split(sep).join('/').split('/').length - 1);
}

/** `build`'s block, with a marker that names this command. */
const AUTO_MARK = '(generated by `fontphobia auto`)';
const blockOf = (o: Parameters<typeof cssBlock>[0]) =>
  cssBlock(o).replace('(generated; rerun `fontphobia build`)', AUTO_MARK);

// ─── The run ────────────────────────────────────────────────────────────────────────────────────

export async function autoSubset(o: AutoOptions): Promise<AutoResult> {
  const root = resolve(o.root);
  const outDir = resolve(o.outDir);
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) throw new Error(`${outDir} is not a directory`);
  if (Object.keys(readManifest(root)?.entries ?? {}).length)
    throw new Error(
      'this project has committed subsets (.fontphobia/manifest.json), which the build already uses; `fontphobia auto` is for projects without them. Run `fontphobia revert` first to switch.',
    );
  const already = () => new Error(`${outDir} was already subset by \`fontphobia auto\`; build the site again first`);
  if (readdirSync(outDir).some((n) => SHEET_NAME.test(n))) throw already();
  const linkedRules = o.rules === 'linked';
  const notes: string[] = [];
  const rules = distRules(outDir);
  // The split rules are in the pages: one of ours there means this output was subset already.
  for (const file of new Set(rules.map((r) => r.css.file)))
    if (readFileSync(join(outDir, file), 'utf8').includes(AUTO_MARK)) throw already();
  const { usage, groups, skipped } = o.usage
    ? crawlGroups(o.usage, rules)
    : await staticUsage(outDir, rules, o.version);
  const mode = o.usage ? 'crawl' : 'static';

  // These opt-ins change a face's descriptors or where it is served from, which only the committed flow can do.
  const off = (o.config?.allow ?? []).filter((a) => ['limit-axes', 'self-host', 'tighten', 'eject'].includes(a));
  if (off.length) notes.push(`${off.join(', ')}: not applied by \`auto\` (the committed flow only)`);
  const cfg: PlanConfig = { ...o.config, allow: (o.config?.allow ?? []).filter((a) => !off.includes(a)) };
  const asked = (name: string) => !!o.config?.allow?.includes(name);
  const addPreloads = asked('add-preloads') && mode === 'crawl';
  const prefetchExt = asked('prefetch-extended') && mode === 'crawl';
  for (const name of ['add-preloads', 'prefetch-extended'])
    if (asked(name) && mode !== 'crawl')
      notes.push(
        `${name}: not applied without \`--crawl\` (reading the built text can't tell which faces a page draws)`,
      );
  const inlineCore = asked('inline-core') && linkedRules;
  if (asked('inline-core') && !linkedRules)
    notes.push(
      "inline-core: not applied without `--rules linked` (inline rules would put the font in every page's HTML, where it is never cached)",
    );
  // inline-core leaves a face alone when a page preloads its source font: font file names pages preload.
  const preloadedSources = new Set<string>();
  if (inlineCore)
    for (const rel of listFiles(outDir, (r) => /\.html?$/i.test(r), {
      skip: (_rel, n) => n === 'node_modules' || n.startsWith('.'),
    })) {
      let html: string;
      try {
        html = readFileSync(join(outDir, rel), 'utf8');
      } catch {
        continue;
      }
      const names = [
        ...[...html.matchAll(/<link\b[^>]*>/gi)]
          .filter((m) => /\brel\s*=\s*["']?preload\b/i.test(m[0]))
          .map((m) => attr(m[0], 'href')),
        ...[...html.matchAll(/HL\[(\\?")([^"\\]+)\1,\\?"font\\?"/g)].map((m) => m[2]),
      ];
      for (const n of names) {
        if (!n) continue;
        const base = posix.basename(n.split(/[?#]/)[0]!);
        try {
          preloadedSources.add(decodeURI(base));
        } catch {
          preloadedSources.add(base);
        }
      }
    }

  // Sources: the output's own font files. A license file sits next to the font in the project, not in the output.
  const sources = new Map<string, SourceFont>();
  let repo: Map<string, string> | undefined;
  for (const g of groups) {
    const r = g.rules[0]!;
    const bytes = new Uint8Array(readFileSync(join(outDir, r.path)));
    try {
      const sfnt = await toSfnt(bytes);
      repo ??= indexFontFiles(root);
      const at = repo.get(r.sha256);
      sources.set(g.id, {
        bytes,
        file: r.path,
        license: at ? detectLicense(sfnt, join(root, at), root) : detectLicense(sfnt, join(outDir, r.path), outDir),
      });
    } catch {
      // planAll reports it: "source font not found".
    }
  }
  const outputs = new Map<string, Uint8Array>();
  const plan = await planAll(usage, sources, cfg, outputs);

  const fonts = new Map<string, Uint8Array>();
  const entries: Record<string, ManifestEntry> = {};
  const edits: Edit[] = [];
  const blocks: string[] = [];
  const sheetFaces: string[] = [];
  const narrowed = new Map<string, Edit>();
  /** Font file name → the core file a preload of it should load instead. */
  const preloads = new Map<string, { to: string; pages: number }>();
  /** Face → its core file's path from the output's root, and the characters it serves. */
  const cores = new Map<string, { path: string; has: Set<number> }>();
  /** Face → its extended file, when at least one audited page draws a character from it. */
  const exts = new Map<string, { path: string; has: Set<number>; bytes: number }>();
  const embedded: NonNullable<AutoResult['embedded']> = [];
  const faces: AutoResult['faces'] = [];
  const texts = new Map<string, string>();
  const textOf = (file: string) => {
    let t = texts.get(file);
    if (t === undefined) texts.set(file, (t = readFileSync(join(outDir, file), 'utf8')));
    return t;
  };
  const planned = new Map<string, FacePlan>(plan.faces.map((f) => [f.id, f]));
  // inline-core: which faces' core files go in the stylesheet. Candidates are faces every audited
  // page draws, declared in a stylesheet, whose source font no page preloads. Smallest first, while
  // the running total stays within the allowance of every face in it (the swap one once any is).
  const allowance = {
    block: typeof o.inlineCoreMax === 'number' ? o.inlineCoreMax : (o.inlineCoreMax?.block ?? INLINE_CORE_MAX.block),
    swap: typeof o.inlineCoreMax === 'number' ? o.inlineCoreMax : (o.inlineCoreMax?.swap ?? INLINE_CORE_MAX.swap),
  };
  /** Face → why its core stays a file, or its font-display when it goes in the stylesheet. */
  const inlineDecision = new Map<string, { embed: true; display: string } | { embed: false; why: string }>();
  if (inlineCore) {
    const pageCount = Object.keys(usage.pages).length;
    // The large allowance needs every page's largest paint to be text (recorded by the crawl).
    const imageLed = Object.entries(usage.pages)
      .filter(([, p]) => p.lcp?.includes('image'))
      .map(([k]) => k);
    const unknown = mode !== 'crawl' || Object.values(usage.pages).some((p) => !p.lcp?.length);
    const blockWhy = unknown
      ? "what each page's largest contentful paint is isn't known (`--crawl` records it)"
      : imageLed.length
        ? `${imageLed.length} page(s) have an image as their largest contentful paint (${imageLed.slice(0, 3).join(', ')}${imageLed.length > 3 ? '…' : ''}), which the stylesheet would delay`
        : undefined;
    if (blockWhy) allowance.block = Math.min(allowance.block, allowance.swap);
    const candidates: { id: string; bytes: number; display: string }[] = [];
    for (const g of groups) {
      const face = planned.get(g.id);
      const sheetRule = g.rules.find((r) => !r.inline);
      const core = face?.files?.find((f) => f.role === 'core');
      if (face?.status !== 'planned' || !sheetRule || !core) continue;
      const on = usage.faces[g.id]?.pages.length ?? 0;
      if (on !== pageCount) inlineDecision.set(g.id, { embed: false, why: `${on} of ${pageCount} page(s) draw it` });
      else if (g.rules.some((r) => preloadedSources.has(posix.basename(r.path))))
        inlineDecision.set(g.id, { embed: false, why: 'a page preloads its source font' });
      else
        candidates.push({
          id: g.id,
          bytes: core.bytes,
          display: sheetRule.css.rule.descriptors['font-display']?.trim().toLowerCase() || 'auto',
        });
    }
    let total = 0;
    let swapIn = false;
    for (const c of candidates.toSorted((a, b) => a.bytes - b.bytes || (a.id < b.id ? -1 : 1))) {
      const withSwap: boolean = swapIn || SWAPS.has(c.display);
      const cap = withSwap ? allowance.swap : allowance.block;
      if (total + c.bytes <= cap) {
        total += c.bytes;
        swapIn = withSwap;
        inlineDecision.set(c.id, { embed: true, display: c.display });
      } else
        inlineDecision.set(c.id, {
          embed: false,
          why: `with it the stylesheet would hold ${kb(total + c.bytes)} of fonts, above the ${kb(cap)} allowed ${
            withSwap
              ? 'once a face has font-display swap, fallback or optional'
              : blockWhy
                ? `for font-display block when ${blockWhy}`
                : 'for font-display block'
          } (\`inlineCoreMax\`): it blocks every page's first paint`,
        });
    }
  }
  for (const g of groups) {
    const face = planned.get(g.id)!;
    if (face.status !== 'planned' || !face.files?.length) {
      skipped.push({ id: g.id, family: face.family, reason: face.reason ?? 'nothing to write' });
      continue;
    }
    const files = face.files;
    const covered = fmt(files.flatMap((f) => [...codePointsOf(parseUnicodeRange(f.unicodeRange))]));
    const block = (r: DistRule, urlOf: (name: string) => string) =>
      blockOf({
        id: face.id,
        version: o.version,
        declaration: textOf(r.css.file).slice(r.css.rule.start, r.css.rule.end),
        sourceUrl: r.url,
        indent: '',
        eol: '\n',
        descriptors: face.descriptors,
        // Rest, extended, core: the order `build` writes (the last rule is the primary font).
        files: files.toReversed().map((f) => ({
          url: urlOf(f.name),
          unicodeRange: f.role === 'core' ? undefined : f.unicodeRange,
        })),
      });
    // A font already cut small (a Google or Fontsource slice) can cost more in three files than in
    // one: what each page of the face would download, against the one file it downloads now.
    const now = face.source?.bytes ?? 0;
    const sets = files.map((f) => ({
      core: f.role === 'core',
      bytes: f.bytes,
      has: new Set(codePointsOf(parseUnicodeRange(f.unicodeRange))),
    }));
    // The rules ride in every page's HTML: their compressed size counts against the saving.
    const first = g.rules.find((r) => !r.inline) ?? g.rules[0]!;
    let inHtml = 0;
    if (!linkedRules)
      try {
        inHtml = gzipSync(block(first, (name) => posix.join(posix.dirname(first.path), name))).byteLength;
      } catch {
        // Reported below, where the rules are written.
      }
    let after = 0;
    let on = 0;
    const heavier: string[] = [];
    for (const [key, p] of Object.entries(usage.pages)) {
      const range = p.faces[g.id];
      if (!range) continue;
      const chars = [...codePointsOf(parseUnicodeRange(range))];
      const cost = sets.reduce((n, f) => n + (f.core || chars.some((c) => f.has.has(c)) ? f.bytes : 0), inHtml);
      after += cost;
      on++;
      if (cost > now) heavier.push(key);
    }
    if (on && now && after >= now * on) {
      skipped.push({
        id: g.id,
        family: face.family,
        reason: `splitting it would not make its pages download less (${kb(now * on)} → ${kb(after)} over ${on} page(s))`,
      });
      continue;
    }
    if (heavier.length)
      notes.push(
        `${face.id}: ${heavier.length} of its ${on} page(s) download more than before (${heavier.slice(0, 3).join(', ')}${heavier.length > 3 ? '…' : ''}), because they use characters from every file; its pages download less in total`,
      );
    const place = (r: DistRule) => {
      for (const f of files) fonts.set(posix.join(posix.dirname(r.path), f.name), outputs.get(f.name)!);
    };
    const entry = (r: DistRule, stylesheet: string, urlOf: (name: string) => string): ManifestEntry => ({
      id: face.id,
      adapter: 'css',
      family: face.family,
      stylesheet,
      declaration: textOf(r.css.file).slice(r.css.rule.start, r.css.rule.end),
      source: { file: r.path, sha256: face.source!.sha256, bytes: face.source!.bytes },
      outputs: files.map((f) => ({
        role: f.role,
        file: posix.join(posix.dirname(r.path), f.name),
        url: urlOf(f.name),
        sha256: f.sha256,
        bytes: f.bytes,
        unicodeRange: f.unicodeRange,
        hintRefs: f.hintRefs,
      })),
      plan: {
        features: face.features,
        axes: face.axes,
        descriptors: face.descriptors,
        hinting: face.hinting,
        optIns: (face.optIns ?? []).filter((x) => x.applied).map((x) => x.id),
        rename: face.license?.rename,
      },
    });
    try {
      const sheetRule = g.rules.find((r) => !r.inline);
      if (sheetRule) {
        place(sheetRule);
        // inline-core: decided above, over all the faces.
        const coreFile = files.find((f) => f.role === 'core');
        const decided = inlineDecision.get(g.id);
        const asData =
          decided?.embed && coreFile
            ? `data:font/woff2;base64,${Buffer.from(outputs.get(coreFile.name)!).toString('base64')}`
            : undefined;
        if (asData) {
          embedded.push({ id: face.id, bytes: coreFile!.bytes });
          const display = decided!.embed ? decided!.display : '';
          if (SWAPS.has(display))
            notes.push(
              `inline-core: ${face.id} has font-display: ${display}, so its pages painted text in a fallback font while it loaded; now their first paint waits for the stylesheet, ${kb(coreFile!.bytes)} larger`,
            );
        } else if (decided && !decided.embed) notes.push(`inline-core: ${face.id} stays a file (${decided.why})`);
        // Paths from the output's root: each page puts its own way there in front.
        const urlOf = (name: string) =>
          asData && name === coreFile!.name
            ? asData
            : ROOT + encodeURI(posix.join(posix.dirname(sheetRule.path), name));
        blocks.push(block(sheetRule, urlOf));
        sheetFaces.push(face.id);
        entries[face.id] = entry(sheetRule, SHEET, urlOf);
      }
      for (const r of g.rules) {
        const { start, end } = r.css.rule;
        if (r.inline && !sheetRule) {
          place(r);
          const clean = r.url.split(/[?#]/)[0]!;
          const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/') + 1) : '';
          edits.push({ file: r.css.file, start, end, text: block(r, (name) => dir + name), why: `split ${face.id}` });
          entries[face.id] ??= entry(r, r.css.file, (name) => dir + name);
        } else if (!r.css.rule.descriptors['unicode-range']) {
          const body = textOf(r.css.file).slice(start, end);
          const close = body.lastIndexOf('}');
          if (close < 0) continue;
          const semi = /[;{]\s*$/.test(body.slice(0, close)) ? '' : ';';
          narrowed.set(`${r.css.file}\u0000${start}`, {
            file: r.css.file,
            start: start + close,
            end: start + close,
            text: `${semi}unicode-range:${covered}`,
            why: `fallback ${face.id}`,
          });
        }
      }
    } catch (e) {
      skipped.push({ id: g.id, family: face.family, reason: `couldn't write its rules: ${(e as Error).message}` });
      continue;
    }
    // One font file can back two faces (normal and italic): its preload goes to the face on more pages.
    const core = files.find((f) => f.role === 'core');
    const n = usage.faces[g.id]?.pages.length ?? 0;
    for (const name of new Set(g.rules.map((r) => posix.basename(r.path))))
      if (core && n > (preloads.get(name)?.pages ?? -1)) preloads.set(name, { to: core.name, pages: n });
    const pathOf = (name: string) => [...fonts.keys()].find((k) => posix.basename(k) === name);
    const corePath = core && pathOf(core.name);
    // A core file that is in the stylesheet has nothing to preload.
    if (core && corePath && !embedded.some((e) => e.id === face.id))
      cores.set(face.id, { path: corePath, has: new Set(codePointsOf(parseUnicodeRange(core.unicodeRange))) });
    const ext = files.find((f) => f.role === 'ext');
    const extPath = ext && pathOf(ext.name);
    if (ext && extPath) {
      const has = new Set(codePointsOf(parseUnicodeRange(ext.unicodeRange)));
      const needed = Object.values(usage.pages).some((p) =>
        [...codePointsOf(parseUnicodeRange(p.faces[g.id] ?? ''))].some((c) => has.has(c)),
      );
      if (needed) exts.set(face.id, { path: extPath, has, bytes: ext.bytes });
    }
    faces.push({ id: face.id, family: face.family, source: face.source!.file, bytes: face.bytes! });
  }

  const sheetText = blocks.length ? blocks.join('\n') + '\n' : '';
  // Linked: the stylesheet sits at the output's root, so its URLs are paths from there.
  const linkedText = sheetText.replaceAll(ROOT, '');
  const sheetName =
    linkedRules && sheetText ? `fontphobia.${sha256(new TextEncoder().encode(linkedText)).slice(0, 8)}.css` : undefined;
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    fontphobia: o.version,
    harfbuzz: harfbuzzVersion(),
    chrome: usage.meta.chrome,
    entries,
  };

  // React's preload hints (Next's `next/font`): `HL["/…/font.ttf","font",{…}]` in the page's inline
  // payload and in the payload files client navigation fetches. React turns each into a preload link.
  const hints = (rel: string, text: string) => {
    for (const m of text.matchAll(/HL\[(\\?")([^"\\]+)\1,\\?"font\\?"[^\]\n]*\]/g)) {
      const path = m[2]!.split(/[?#]/)[0]!;
      const name = posix.basename(path);
      let to: { to: string } | undefined;
      try {
        to = preloads.get(decodeURI(name));
      } catch {
        continue;
      }
      if (!to) continue;
      const next = m[0]
        .replace(m[2]!, path.slice(0, path.length - name.length) + to.to)
        .replace(/font\/[a-z0-9]+/i, 'font/woff2');
      if (next !== m[0])
        edits.push({ file: rel, start: m.index, end: m.index + m[0].length, text: next, why: `preload → ${to.to}` });
    }
  };
  if (preloads.size)
    for (const rel of listFiles(outDir, (r) => /\.(txt|rsc)$/i.test(r), {
      skip: (_rel, n) => n === 'node_modules' || n.startsWith('.'),
      max: 20_000,
    })) {
      try {
        if (statSync(join(outDir, rel)).size > 5_000_000) continue;
        const text = readFileSync(join(outDir, rel), 'utf8');
        if (text.includes('HL[')) hints(rel, text);
      } catch {
        // unreadable: left as it is
      }
    }

  // The pages: the link, the preloads, and which stylesheets a page pins by hash.
  const pinned = new Set<string>();
  let linked = 0;
  const preloaded = { links: 0, pages: 0 };
  const prefetched = { files: new Set<string>(), pages: 0 };
  let carrier: { rel: string; prefix: string } | undefined;
  let csp: string | undefined;
  const pages = listFiles(outDir, (r) => /\.html?$/i.test(r), {
    skip: (_rel, n) => n === 'node_modules' || n.startsWith('.'),
  });
  for (const rel of pages) {
    let html: string;
    try {
      html = textOf(rel);
    } catch {
      continue;
    }
    texts.delete(rel);
    /** File names this page preloads, as they will be once its preloads point at core files. */
    const has = new Set<string>();
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const href = attr(tag, 'href');
      if (!href) continue;
      const name = posix.basename(href.split(/[?#]/)[0]!);
      if (/\brel\s*=\s*["']?preload\b/i.test(tag)) {
        try {
          has.add(preloads.get(decodeURI(name))?.to ?? decodeURI(name));
        } catch {
          has.add(name);
        }
      }
      if (/\bintegrity\s*=/i.test(tag)) {
        pinned.add(name);
        continue;
      }
      let to: { to: string } | undefined;
      try {
        to = /\brel\s*=\s*["']?preload\b/i.test(tag) ? preloads.get(decodeURI(name)) : undefined;
      } catch {
        continue;
      }
      if (!to) continue;
      const path = href.split(/[?#]/)[0]!;
      const next = tag
        .replace(href, path.slice(0, path.length - name.length) + to.to)
        .replace(/(\btype\s*=\s*["']?)font\/[a-z0-9]+/i, '$1font/woff2');
      if (next !== tag)
        edits.push({ file: rel, start: m.index, end: m.index + tag.length, text: next, why: `preload → ${to.to}` });
    }
    hints(rel, html);
    const head = html.search(/<\/head\s*>/i);
    if (head < 0) continue;
    const seen = mode === 'crawl' ? usage.pages[pageKey(rel)] : undefined;
    let prefix: string | undefined;
    // add-preloads: the core file of each face this page draws from it, unless the page preloads it already.
    let links = '';
    if (addPreloads && seen)
      for (const [id, core] of cores) {
        const range = seen.faces[id];
        if (!range || has.has(posix.basename(core.path))) continue;
        if (![...codePointsOf(parseUnicodeRange(range))].some((c) => core.has.has(c))) continue;
        has.add(posix.basename(core.path));
        prefix ??= hrefPrefix(outDir, rel, html);
        links += `<link rel="preload" href="${prefix}${encodeURI(core.path)}" as="font" type="font/woff2" crossorigin>`;
        preloaded.links++;
      }
    if (links) preloaded.pages++;
    // prefetch-extended: the extended files other pages need and this one doesn't.
    let prefetches = '';
    if (prefetchExt && seen)
      for (const [id, ext] of exts) {
        if ([...codePointsOf(parseUnicodeRange(seen.faces[id] ?? ''))].some((c) => ext.has.has(c))) continue;
        prefix ??= hrefPrefix(outDir, rel, html);
        prefetches += `<link rel="prefetch" href="${prefix}${encodeURI(ext.path)}" as="font" type="font/woff2" crossorigin>`;
        prefetched.files.add(ext.path);
      }
    if (prefetches) prefetched.pages++;
    links += prefetches;
    // A crawled page that draws none of these faces doesn't need them; a page the crawl never saw might.
    const rulesHere = !!sheetText && !(seen && !sheetFaces.some((id) => seen.faces[id]));
    if (!rulesHere) {
      if (links) edits.push({ file: rel, start: head, end: head, text: links, why: 'preloads and prefetches' });
      continue;
    }
    prefix ??= hrefPrefix(outDir, rel, html);
    // One edit: the preloads, then the rules, which stay the last thing in the <head>.
    edits.push({
      file: rel,
      start: head,
      end: head,
      text:
        links +
        (sheetName
          ? `<link rel="stylesheet" href="${prefix}${sheetName}">`
          : `<style data-fontphobia>\n${sheetText.replaceAll(ROOT, prefix)}</style>`),
      why: 'the split rules',
    });
    linked++;
    carrier ??= { rel, prefix };
    if (!sheetName && !csp && /http-equiv\s*=\s*["']?content-security-policy/i.test(html) && /style-src/i.test(html))
      csp = rel;
  }
  // The checks read each entry's block in one of the pages that carry it.
  for (const e of Object.values(entries)) {
    if (e.stylesheet !== SHEET) continue;
    if (!carrier) throw new Error(`no page in ${outDir} has a <head> to put the split @font-face rules in`);
    e.stylesheet = sheetName ?? carrier.rel;
    for (const x of e.outputs) x.url = x.url.replace(ROOT, sheetName ? '' : carrier.prefix);
  }
  if (csp)
    notes.push(
      `${csp} sets a Content-Security-Policy with style-src: unless it allows inline styles, the browser ignores the split rules and the original fonts load`,
    );
  // A stylesheet a page checks by hash (`integrity`) can't change: its rules stay as they are.
  for (const e of narrowed.values()) {
    if (pinned.has(posix.basename(e.file))) {
      const note = `${e.file} is loaded with an integrity hash, so its @font-face rules were left unchanged: a character none of the font's files has makes the original font download`;
      if (!notes.includes(note)) notes.push(note);
    } else edits.push(e);
  }
  if (mode === 'static' && faces.length)
    notes.push(
      'static: every face got every character of the pages that it can draw and all of its OpenType features; `--crawl` measures each face in Chrome',
    );

  const write = o.write !== false;
  const out = [...fonts].toSorted(([a], [b]) => (a < b ? -1 : 1));
  let edited: string[] = [...new Set(edits.map((e) => e.file))].toSorted();
  let checked: AutoResult['checked'];
  if (write) {
    const before = new Map(edited.map((f) => [f, readFileSync(join(outDir, f))]));
    const added = [...out.map(([f]) => f), ...(sheetName ? [sheetName] : [])].filter(
      (f) => !existsSync(join(outDir, f)),
    );
    const undo = () => {
      for (const [f, bytes] of before) writeFileSync(join(outDir, f), bytes);
      for (const f of added) rmSync(join(outDir, f), { force: true });
    };
    let st: StaticVerify;
    try {
      for (const [file, bytes] of out) writeFileSync(join(outDir, file), bytes);
      if (sheetName) writeFileSync(join(outDir, sheetName), linkedText);
      edited = applyEdits(outDir, edits);
      // The same checks as `verify --no-browser`, on what is now on disk.
      st = await verifyStatic(outDir, usage, manifest);
    } catch (e) {
      undo();
      throw e;
    }
    const bad = st.findings.filter((f) => f.severity === 'regression');
    if (bad.length) {
      undo();
      throw new AutoVerifyError(
        `the subset files failed their checks, so the output was put back as it was:\n${bad
          .slice(0, 10)
          .map((f) => `  ${f.id}: ${f.message}`)
          .join('\n')}`,
      );
    }
    checked = {
      outputs: st.outputs.size,
      words: st.shaping.reduce((n, x) => n + x.words, 0),
      cases: st.shaping.reduce((n, x) => n + x.cases, 0),
    };
  }
  return {
    mode,
    plan,
    faces,
    fonts: out.map(([file, bytes]) => ({ file, bytes: bytes.byteLength })),
    inlined: sheetText && !sheetName ? { bytes: Buffer.byteLength(sheetText) } : undefined,
    stylesheet: sheetName ? { file: sheetName, bytes: Buffer.byteLength(linkedText) } : undefined,
    linked,
    preloaded: preloaded.links ? preloaded : undefined,
    prefetched: prefetched.pages
      ? {
          files: prefetched.files.size,
          bytes: [...exts.values()].filter((e) => prefetched.files.has(e.path)).reduce((n, e) => n + e.bytes, 0),
          pages: prefetched.pages,
        }
      : undefined,
    embedded: embedded.length ? embedded : undefined,
    edited,
    skipped,
    notes,
    written: write,
    checked,
    manifest,
    usage,
  };
}

export function formatAuto(r: AutoResult, outDir: string): string {
  const L: string[] = [];
  const did = r.written ? '' : ' (dry run: nothing written)';
  if (!r.faces.length) L.push(`fontphobia auto (${r.mode}): no font in ${outDir} to subset${did}`);
  else {
    L.push(`fontphobia auto (${r.mode}): ${r.faces.length} face(s) subset in ${outDir}${did}`);
    for (const f of r.faces)
      L.push(
        `  ${f.id}  ${kb(f.bytes.now)} → core ${kb(f.bytes.core)}${f.bytes.ext ? `, extended ${kb(f.bytes.ext)}` : ''}${f.bytes.rest ? `, rest ${kb(f.bytes.rest)}` : ''}  (${f.source})`,
      );
    const parts = [`${r.fonts.length} font file(s)`];
    if (r.inlined) parts.push(`the split rules (${kb(r.inlined.bytes)}) in ${r.linked} page(s)`);
    if (r.stylesheet) parts.push(`${r.stylesheet.file} (${kb(r.stylesheet.bytes)}), linked from ${r.linked} page(s)`);
    L.push(`${r.written ? 'Wrote' : 'Would write'} ${parts.join(' and ')}; ${r.edited.length} file(s) edited`);
    if (r.preloaded)
      L.push(
        `${r.written ? 'Added' : 'Would add'} ${r.preloaded.links} preload(s) of core files to ${r.preloaded.pages} page(s)`,
      );
    if (r.prefetched)
      L.push(
        `${r.prefetched.pages} page(s) ${r.written ? 'now prefetch' : 'would prefetch'} ${r.prefetched.files} extended file(s) they don't need themselves (${kb(r.prefetched.bytes)} in all, once per visitor)`,
      );
    if (r.embedded)
      L.push(
        `${r.written ? 'Put' : 'Would put'} ${r.embedded.length} core file(s) in the stylesheet as data: URLs (${kb(r.embedded.reduce((n, e) => n + e.bytes, 0))}): ${r.embedded.map((e) => e.id).join(', ')}`,
      );
    if (r.checked)
      L.push(
        `Checked without a browser: ${r.checked.outputs} file(s) decode and match their sources, and ${r.checked.words} word(s) shape identically in ${r.checked.cases} case(s)`,
      );
  }
  if (r.skipped.length) {
    L.push('Left as they are:');
    // A family in slices (Fontsource, Google) has many faces no page uses: one line for them.
    const by = new Map<string, string[]>();
    for (const s of r.skipped) {
      const k = `${s.family}\u0000${s.reason}`;
      by.set(k, [...(by.get(k) ?? []), s.id]);
    }
    for (const [k, ids] of by) {
      const [family, reason] = k.split('\u0000');
      L.push(ids.length > 2 ? `  ${family}, ${ids.length} faces: ${reason}` : `  ${ids.join(', ')}: ${reason}`);
    }
  }
  for (const n of r.notes) L.push(`note: ${n}`);
  return L.join('\n');
}
