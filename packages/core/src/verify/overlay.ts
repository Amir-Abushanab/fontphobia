// The overlay baseline (§10.3): "before" is the built site as served, with each generated
// @font-face swapped back to the original declaration, preloads pointed back at the source, and the
// source font served from the repo. HTML and JS stay byte-identical, so only the fonts differ.
// Bundlers drop the marker comments and rename files, so rules are matched by the output file:
// its name (`<stem>.<role>.<hash8>`, kept inside a bundler's own renaming) or, for files inlined
// as data: URLs, its sha256.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import postcss, { type AtRule } from 'postcss';
import { splitTop, unquote } from '../css/values.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import { parseCss, syntaxOf } from '../build/css.ts';
import type { Manifest, ManifestEntry } from '../build/manifest.ts';

export const BEFORE_PREFIX = '/__fontphobia/before/';

export interface OutputRef {
  entry: ManifestEntry;
  role: string;
  file: string;
}

export interface Overlay {
  /** The output a URL (or data: URL) loads, if any. */
  outputOf(url: string): OutputRef | undefined;
  /** Every entry's output a URL loads (one file can serve two entries). */
  outputsOf(url: string): OutputRef[];
  /** The virtual URL that serves an entry's source font in "before". */
  sourceUrl(e: ManifestEntry): string;
  /** Repo path of the source font behind a virtual URL path. */
  sourceFile(pathname: string): { file: string; sha256: string } | undefined;
  /** CSS with generated rules swapped back, or undefined when nothing matched. `hits` gets the entries found. */
  restoreCss(css: string, hits?: Set<string>): string | undefined;
  /** HTML with inline <style> blocks restored and preloads pointed back at the sources. */
  restoreHtml(html: string, hits?: Set<string>): string | undefined;
  /** Which entries a stylesheet (or HTML) uses, without rewriting. */
  scan(text: string): Set<string>;
  /** The original Google stylesheet URL behind a tightened one (§6.5), if fontphobia rewrote it. */
  originalSheet(url: string): string | undefined;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const URL_RE = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
/** A file name with `.`, `_` and `-` removed, for matching outputs through bundler renames. */
export const squash = (name: string): string => name.replace(/[._-]/g, '').toLowerCase();

function dataBytes(u: string): Uint8Array | undefined {
  const m = u.match(/^data:[^,]*?(;base64)?,(.*)$/is);
  if (!m) return undefined;
  try {
    return new Uint8Array(
      m[1] ? Buffer.from(decodeURIComponent(m[2]!), 'base64') : Buffer.from(decodeURIComponent(m[2]!), 'latin1'),
    );
  } catch {
    return undefined;
  }
}

export function createOverlay(manifest: Manifest): Overlay {
  const byStem: [string, OutputRef][] = [];
  const bySha = new Map<string, OutputRef[]>();
  const sources = new Map<string, { file: string; sha256: string }>();
  for (const e of Object.values(manifest.entries)) {
    for (const o of e.outputs) {
      const ref = { entry: e, role: o.role, file: o.file };
      byStem.push([posix.basename(o.file).replace(/\.woff2$/, ''), ref]);
      bySha.set(o.sha256, [...(bySha.get(o.sha256) ?? []), ref]);
    }
    sources.set(e.source.sha256.slice(0, 16), { file: e.source.file, sha256: e.source.sha256 });
  }
  const sourceUrl = (e: ManifestEntry) =>
    `${BEFORE_PREFIX}${e.source.sha256.slice(0, 16)}/${encodeURIComponent(posix.basename(e.source.file))}`;

  const outputsOf = (url: string): OutputRef[] => {
    if (/^data:/i.test(url)) {
      const b = dataBytes(url);
      return b ? (bySha.get(sha(b)) ?? []) : [];
    }
    let name: string;
    try {
      name = decodeURIComponent(posix.basename(new URL(url, 'http://x/').pathname));
    } catch {
      return [];
    }
    // Bundlers rename: Vite appends a hash, Next turns dots into underscores (`x_core_1a2b3c4d-s.p.….woff2`).
    const flat = squash(name);
    return byStem.filter(([stem]) => flat.includes(squash(stem))).map(([, r]) => r);
  };
  const outputOf = (url: string): OutputRef | undefined => outputsOf(url)[0];

  // An entry's declaration in its stylesheet's syntax (Sass or Less `//` comments). Without the
  // file's text a <style lang="scss"> block reads as css, so that falls back to Sass's parser.
  const declRoot = (e: ManifestEntry): postcss.Root => {
    const s = syntaxOf(e.stylesheet);
    try {
      return parseCss(e.declaration, s);
    } catch (x) {
      if (s !== 'css') throw x;
      return parseCss(e.declaration, 'scss');
    }
  };
  // The original declaration, with the url that loaded the source pointed at the virtual URL.
  const restored = (e: ManifestEntry): string => {
    const root = declRoot(e);
    const rule = root.first as AtRule;
    const srcName = posix.basename(e.source.file);
    rule.walkDecls(/^src$/i, (d) => {
      const parts = splitTop(d.value);
      const urls = parts.filter((p) => /url\(/i.test(p));
      const main =
        urls.find((p) =>
          [...p.matchAll(URL_RE)].some((m) => posix.basename(unquote(m[2]!).split(/[?#]/)[0]!) === srcName),
        ) ?? urls[0];
      d.value = parts
        .filter((p) => !/url\(/i.test(p) || p === main)
        .map((p) => (p === main ? p.replace(URL_RE, `url("${sourceUrl(e)}")`) : p.trim()))
        .join(', ');
    });
    return root.toString();
  };

  // One file can back two entries (the same source and set for normal and italic): tell them apart by style.
  const styleOf = (decls: Record<string, string>) =>
    (decls['font-style'] ?? 'normal').trim().toLowerCase().split(/\s+/)[0];
  const origStyle = new Map(
    Object.values(manifest.entries).map((e) => [
      e.id,
      styleOf(parseStylesheet(e.declaration, { syntax: syntaxOf(e.stylesheet) }).fontFaces[0]?.descriptors ?? {}),
    ]),
  );
  const entryOf = (rule: AtRule): ManifestEntry | undefined => {
    const refs: OutputRef[] = [];
    rule.walkDecls(/^src$/i, (d) => {
      for (const m of d.value.matchAll(URL_RE)) refs.push(...outputsOf(unquote(m[2]!)));
    });
    if (refs.length < 2) return refs[0]?.entry;
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop.toLowerCase()] = d.value;
    });
    return (refs.find((r) => origStyle.get(r.entry.id) === styleOf(decls)) ?? refs[0])!.entry;
  };
  // Cheap pre-check before parsing: the hash8 survives every bundler rename seen so far.
  const maybe = (css: string) =>
    byStem.some(([stem]) => css.includes(stem.split('.').pop()!)) || /url\(\s*["']?data:/i.test(css);

  const restoreCss = (css: string, hits?: Set<string>): string | undefined => {
    if (!maybe(css)) return undefined;
    let root: postcss.Root;
    try {
      root = postcss.parse(css);
    } catch {
      return undefined;
    }
    const done = new Set<string>();
    let changed = false;
    root.walkAtRules(/^font-face$/i, (r) => {
      const e = entryOf(r);
      if (!e) return;
      hits?.add(e.id);
      changed = true;
      if (done.has(e.id)) {
        r.remove();
        return;
      }
      done.add(e.id);
      if (!e.declaration) {
        // next/font writes the CSS itself (§6.3): keep its rule, load the source font instead.
        const ext = posix.extname(e.source.file).slice(1).toLowerCase();
        const format = ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : ext;
        r.walkDecls(/^src$/i, (d) => {
          d.value = `url("${sourceUrl(e)}") format("${format}")`;
        });
        return;
      }
      const node = postcss.parse(restored(e)).first!;
      r.replaceWith(node);
    });
    return changed ? root.toString() : undefined;
  };

  const restoreHtml = (html: string, hits?: Set<string>): string | undefined => {
    let changed = false;
    let out = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (all, a: string, body: string, b: string) => {
      const r = restoreCss(body, hits);
      if (r === undefined) return all;
      changed = true;
      return a + r + b;
    });
    out = out.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel\s*=\s*["']?[^"'>]*\bpreload\b/i.test(tag)) return tag;
      const m = tag.match(/\bhref\s*=\s*(["']?)([^"'\s>]+)\1/i);
      const ref = m && outputOf(m[2]!);
      if (!ref) return tag;
      changed = true;
      return tag.replace(m[0], `href=${m[1] || '"'}${sourceUrl(ref.entry)}${m[1] || '"'}`);
    });
    return changed ? out : undefined;
  };

  const scan = (text: string): Set<string> => {
    const s = new Set<string>();
    if (!maybe(text)) return s;
    for (const f of parseStylesheet(text).fontFaces)
      for (const x of f.src) for (const r of x.url ? outputsOf(x.url) : []) s.add(r.entry.id);
    return s;
  };

  const norm = (u: string) => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };
  const sheets = new Map((manifest.google ?? []).map((r) => [norm(r.to), r.from]));
  return {
    outputOf,
    outputsOf,
    sourceUrl,
    restoreCss,
    restoreHtml,
    scan,
    originalSheet: (url) => sheets.get(norm(url)),
    sourceFile: (pathname) => {
      if (!pathname.startsWith(BEFORE_PREFIX)) return undefined;
      return sources.get(pathname.slice(BEFORE_PREFIX.length).split('/')[0]!);
    },
  };
}
