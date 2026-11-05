// `fontphobia check` (§12), static mode: no browser, no network, fast enough for a postbuild script
// or a build hook. It compares the repo and the built site with what the written files actually
// contain (their cmap, GSUB/GPOS features and axis ranges, read from the WOFF2s) and exits 1, with
// the reason and the command to run, when the subsets are out of date:
//  - a source font, an output or a marked block changed;
//  - an @font-face outside the blocks was added, removed or edited;
//  - CSS asks a subset for a feature or an axis value it no longer has;
//  - built text (HTML, inline styles, JS/JSON string literals) has characters a face's core and
//    extended files don't cover. Approximate: unrendered strings cause false alarms; `allowChars`
//    silences them.
import { findFontCheckCalls, PAGE_TEXT } from '../project/font-checks.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { detectCss } from '../adapters/css.ts';
import { desiredWeights, matchWeight, namesFamily, neededWeights, repoText } from '../adapters/google-url.ts';
import { literalProp } from '../adapters/next-font.ts';
import { optionsLabel, weightKeyOf } from '../build/narrow-options.ts';
import { resolveFontsource } from '../adapters/fontsource.ts';
import { cssDemands, newDemands, otherFaces } from '../build/fingerprint.ts';
import { readManifest, type Manifest, type ManifestEntry } from '../build/manifest.ts';
import { codePointsOf, parseUnicodeRange } from '../css/unicode-range.ts';
import { familyKey } from '../css/values.ts';
import { detectProject, findSite, listFiles } from '../project/detect.ts';
import { fontFacts } from '../usage/facts.ts';
import type { FontFacts } from '../usage/capture.ts';
import type { UsageFileJson } from '../plan/planner.ts';
import { checkCss } from '../verify/static.ts';

export type CheckKind = 'source' | 'output' | 'block' | 'face' | 'feature' | 'axis' | 'chars';

/**
 * `error`: the site would render differently, or the files no longer match the build.
 * `warning`: it renders the same but downloads more than it should (characters served by the rest
 * file). Warnings fail only with `strict`, since the character check is approximate.
 */
export interface CheckIssue { kind: CheckKind; severity: 'error' | 'warning'; id?: string; file?: string; message: string }

export interface CheckOptions {
  root: string;
  /** The built site to read text from (default: what the framework profile finds). */
  outputDir?: string;
  /** usage.json: which faces draw on which page, for the character check. */
  usage?: UsageFileJson;
  /** Characters never reported (strings that never render). */
  allowChars?: string;
  /** Fail on warnings too (characters that would load the rest file). */
  strict?: boolean;
}

export interface CheckResult {
  /** No errors (no issues at all, with `strict`). */
  ok: boolean;
  issues: CheckIssue[];
  /** The command that brings the subsets up to date. */
  command: string;
  checked: { entries: number; outputs: number; styleFiles: number; textFiles: number };
  notes: string[];
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const show = (cps: number[]) => cps.slice(0, 12).map((c) => `${String.fromCodePoint(c)} (${hex(c)})`).join(', ') + (cps.length > 12 ? ` and ${cps.length - 12} more` : '');
const rangeSet = (r: string | undefined) => new Set(r ? codePointsOf(parseUnicodeRange(r)) : []);


/** `pnpm dlx fontphobia@1.2.3 --write`, in the project's package manager. */
export function rerunCommand(root: string, version: string): string {
  const pm = detectProject(root).packageManager;
  const pkg = `fontphobia@${version}`;
  return pm === 'npm' ? `npx ${pkg} --write` : pm === 'yarn' ? `yarn dlx ${pkg} --write` : pm === 'bun' ? `bunx ${pkg} --write` : pm === 'deno' ? `deno run -A npm:${pkg} --write` : `pnpm dlx ${pkg} --write`;
}

// ─── Text from the built site ───────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', laquo: '«', raquo: '»' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);

/** Visible text of an HTML file, plus attribute text that renders (alt, title, placeholder, value) and CSS `content`. */
export function htmlText(html: string): string {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join('\n') + [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!).join('\n');
  const content = [...css.matchAll(/content\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/gi)].map((m) => m[2]!.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))).join(' ');
  const attrs = [...html.matchAll(/\b(?:alt|title|placeholder|value|aria-label)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!).join(' ');
  const body = html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
  return decode(`${body} ${attrs}`) + ' ' + content;
}

/** String literals in JS or JSON (escapes decoded), which may become rendered text. */
export function scriptStrings(js: string): string {
  const out: string[] = [];
  for (const m of js.matchAll(/(["'`])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1/g)) {
    const s = m[2]!;
    if (!/[^\x00-\x7f]|\\u/.test(s)) continue;
    out.push(s.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a?: string, b?: string, c?: string) => String.fromCodePoint(parseInt((a ?? b ?? c)!, 16))));
  }
  return out.join(' ');
}

/** Page key ("/about/") of a built HTML file, the way the audit names pages. */
const pageOf = (rel: string) => {
  const p = '/' + rel.split(sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
};

// ─── The check ─────────────────────────────────────────────────────────────────────────────────

interface EntryFacts { e: ManifestEntry; source?: FontFacts; outputs: FontFacts[]; kept: Set<number>; rest: Set<number>; families: string }

export async function checkProject(o: CheckOptions): Promise<CheckResult> {
  const root = o.root;
  const manifest: Manifest | undefined = readManifest(root);
  const notes: string[] = [];
  if (!manifest || (!Object.keys(manifest.entries).length && !manifest.google?.length && !manifest.options?.length && !manifest.kits?.length)) {
    return { ok: true, issues: [], command: '', checked: { entries: 0, outputs: 0, styleFiles: 0, textFiles: 0 }, notes: ['no fontphobia.manifest.json: nothing has been built to check'] };
  }
  const issues: CheckIssue[] = [];
  const add = (i: Omit<CheckIssue, 'severity'> & { severity?: CheckIssue['severity'] }) => issues.push({ severity: 'error', ...i });
  const allow = new Set([...(o.allowChars ?? '')].map((c) => c.codePointAt(0)!));

  // 1. Sources, outputs and blocks, as built.
  const facts: EntryFacts[] = [];
  let outputs = 0;
  for (const e of Object.values(manifest.entries).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const f: EntryFacts = { e, outputs: [], kept: new Set(), rest: new Set(), families: familyKey(e.family) };
    const src = join(root, e.source.file);
    if (!existsSync(src)) add({ kind: 'source', id: e.id, file: e.source.file, message: `the source font ${e.source.file} is gone` });
    else {
      const bytes = new Uint8Array(readFileSync(src));
      if (sha(bytes) !== e.source.sha256) add({ kind: 'source', id: e.id, file: e.source.file, message: `${e.source.file} changed since the build` });
      f.source = await fontFacts(bytes);
    }
    for (const out of e.outputs) {
      outputs++;
      const p = join(root, out.file);
      if (!existsSync(p)) { add({ kind: 'output', id: e.id, file: out.file, message: `${out.file} is missing` }); continue; }
      const bytes = new Uint8Array(readFileSync(p));
      if (sha(bytes) !== out.sha256) add({ kind: 'output', id: e.id, file: out.file, message: `${out.file} changed since the build` });
      f.outputs.push(await fontFacts(bytes));
      for (const c of rangeSet(out.unicodeRange)) (out.role === 'rest' ? f.rest : f.kept).add(c);
    }
    if (e.next) {
      const t = existsSync(join(root, e.next.file)) ? readFileSync(join(root, e.next.file), 'utf8') : '';
      if (!new RegExp(`["']${e.next.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(t)) add({ kind: 'block', id: e.id, file: e.next.file, message: `${e.next.file} no longer loads ${e.next.to} in its localFont() call` });
    } else checkCss(root, e, (_k, severity, message) => { if (severity === 'regression') add({ kind: 'block', id: e.id, file: e.stylesheet, message }); });
    facts.push(f);
  }

  // Font readiness checks (§6): a call added since the build waits for the core file only.
  for (const call of findFontCheckCalls(root)) {
    if (call.fixable) add({ kind: 'block', severity: 'warning', file: call.file, message: `${call.file}:${call.line} \`${call.call.length > 60 ? call.call.slice(0, 57) + '…' : call.call}\` waits for the core file only now that the font is split; pass the page's text (\`${PAGE_TEXT}\`) as the second argument, or rerun build to do it` });
  }
  // fontsource ejects (§6.2): the installed package must be the version the copy was made from.
  for (const [file, ej] of Object.entries(manifest.ejects ?? {})) {
    for (const sn of ej.snippets ?? []) {
      const t = existsSync(join(root, sn.file)) ? readFileSync(join(root, sn.file), 'utf8') : '';
      if (!t.includes(sn.to)) add({ kind: 'block', file: sn.file, message: `${sn.file} changed where fontphobia ejected ${ej.package}; rerun build` });
    }
    if (ej.kind && ej.kind !== 'fontsource') continue; // the sources are committed copies of the provider's files
    const pkg = resolveFontsource(root, ej.imports[0]?.file ?? file, ej.specifier);
    if (!pkg) add({ kind: 'source', file, message: `${ej.package} isn't installed any more (${file} was ejected from it)` });
    else if (pkg.version !== ej.version) add({ kind: 'source', file, message: `${ej.package} is ${pkg.version} now; ${file} was ejected from ${ej.version}` });
  }

  // google-fonts tighten (§6.5): the rewritten URLs still there, and nothing asks for what they dropped.
  if (manifest.google?.length) {
    const texts = repoText(root);
    const weights = desiredWeights(texts);
    for (const r of manifest.google) {
      const amp = r.to.replace(/&/g, '&amp;');
      for (const f of r.files) {
        const t = existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '';
        if (!t.includes(r.to) && !t.includes(amp)) add({ kind: 'block', file: f, message: `${f} no longer loads the Google Fonts URL fontphobia wrote (${r.to})` });
      }
      for (const fam of r.dropped.families) {
        const by = namesFamily(texts, fam);
        if (by.length) add({ kind: 'face', file: by[0], message: `${by[0]} names ${fam}, which build dropped from the Google Fonts URL because nothing used it` });
      }
      for (const [fam, ws] of Object.entries(r.dropped.weights)) {
        const need = neededWeights(r.from, fam, ws, weights);
        if (need.length) add({ kind: 'axis', message: `${fam} ${need.join(', ')} ${need.length > 1 ? 'are' : 'is'} asked for again${weights ? '' : ' (a font-weight is computed)'}, but build dropped ${need.length > 1 ? 'them' : 'it'} from the Google Fonts URL` });
      }
      for (const [fam, tags] of Object.entries(r.dropped.axes)) {
        for (const tag of tags) if (texts.some((x) => new RegExp(`["']${tag}["']\\s+-?\\d`).test(x.text))) add({ kind: 'axis', message: `the code sets '${tag}', which build dropped from ${fam}'s Google Fonts URL (limit-axes)` });
      }
    }
  }

  // next/font/google (§6.4) and Astro fonts[] (§6.8): the narrowed options still there, and nothing asks for what they dropped.
  if (manifest.options?.length) {
    const texts = repoText(root);
    const weights = desiredWeights(texts);
    for (const r of manifest.options) {
      const t = existsSync(join(root, r.file)) ? readFileSync(join(root, r.file), 'utf8') : '';
      if (!t.includes(r.to)) add({ kind: 'block', file: r.file, message: `${optionsLabel(r)} changed since fontphobia narrowed it; rerun build` });
      if (r.dropped.weights.length) {
        const all = [...new Set([...(literalProp(r.from, weightKeyOf(r.adapter))?.values ?? []).map(Number)])];
        const need = weights ? [...new Set([...weights].map((d) => matchWeight(d, all)!))].filter((w) => r.dropped.weights.includes(w)).sort((a, b) => a - b) : r.dropped.weights;
        if (need.length) add({ kind: 'axis', file: r.file, message: `${r.family} ${need.join(', ')} ${need.length > 1 ? 'are' : 'is'} asked for again${weights ? '' : ' (a font-weight is computed)'}, but build dropped ${need.length > 1 ? 'them' : 'it'} from ${optionsLabel(r)}` });
      }
      for (const tag of r.dropped.axes) if (texts.some((x) => new RegExp(`["']${tag}["']\\s+-?\\d`).test(x.text))) add({ kind: 'axis', file: r.file, message: `the code sets '${tag}', which build dropped from ${optionsLabel(r)} (limit-axes)` });
    }
  }

  // 2. Other @font-face rules, against the build's fingerprint.
  const css = detectCss(root);
  if (manifest.others) {
    const now = otherFaces(root, css.filter((c) => !manifest.ejects?.[c.file]));
    const key = (x: { file: string; family: string; sha256: string }) => `${x.file}\u0000${x.family}\u0000${x.sha256}`;
    const before = new Set(manifest.others.map(key)), after = new Set(now.map(key));
    const fam = (x: { file: string; family: string }) => `${x.family} in ${x.file}`;
    for (const x of now) if (!before.has(key(x))) add({ kind: 'face', file: x.file, message: manifest.others.some((y) => y.file === x.file && y.family === x.family) ? `the @font-face for ${fam(x)} changed` : `an @font-face for ${fam(x)} was added` });
    for (const x of manifest.others) if (!after.has(key(x)) && !now.some((y) => y.file === x.file && y.family === x.family)) add({ kind: 'face', file: x.file, message: `the @font-face for ${fam(x)} was removed` });
  } else notes.push('this manifest predates @font-face fingerprints: rebuild once to check added or changed faces');

  // 3. Features and axis values the CSS asks for, new since the build.
  const all = cssDemands(root);
  const styleFiles = new Set(all.map((d) => d.file));
  if (!manifest.demands) notes.push('this manifest predates CSS fingerprints: every feature and axis value in the CSS is checked');
  const declared = newDemands(all, manifest.demands);
  const reported = new Set<string>();
  for (const d of declared) {
    const targets = facts.filter((f) => !d.families || d.families.includes(f.families));
    if (!targets.length) continue;
    const feats = d.features, axes = d.axes;
    for (const f of targets) {
      if (!f.source || !f.outputs.length) continue;
      const have = new Set(f.outputs.flatMap((x) => [...x.features]));
      for (const [tag, v] of feats) {
        if (!v || !f.source.features.has(tag) || have.has(tag)) continue;
        const k = `feature ${f.e.id} ${tag}`;
        if (!reported.has(k)) { reported.add(k); add({ kind: 'feature', id: f.e.id, file: d.file, message: `${d.file} turns on '${tag}', which ${f.e.family}'s subsets don't keep` }); }
      }
      for (const [tag, v] of axes) {
        const sa = f.source.axes.find((a) => a.tag === tag);
        if (!sa || v < sa.min || v > sa.max) continue; // the source can't do it either
        const oa = f.outputs[0]!.axes.find((a) => a.tag === tag);
        const ok = oa ? v >= oa.min && v <= oa.max : false;
        if (ok) continue;
        const k = `axis ${f.e.id} ${tag} ${v}`;
        if (!reported.has(k)) { reported.add(k); add({ kind: 'axis', id: f.e.id, file: d.file, message: `${d.file} asks for ${tag} ${v}, outside ${f.e.family}'s subsets (${oa ? `${oa.min}–${oa.max}` : 'axis pinned'}; limit-axes)` }); }
      }
    }
  }

  // 4. Characters in the built site.
  let textFiles = 0;
  const project = detectProject(root);
  const outDir = o.outputDir ?? (() => { const s = findSite(project); return s?.mode === 'static' ? s.dir : undefined; })();
  if (!outDir) notes.push('no built static output found: the character check needs prerendered HTML (pass --dist)');
  else {
    // Not fontphobia's own files when the site is served from the project root (usage.json, the manifest).
    const files = listFiles(outDir, (r) => /\.(html?|m?js|json)$/i.test(r) && !r.endsWith('fontphobia.manifest.json') && !r.endsWith('.fontphobia/manifest.json'), { skip: (_rel, n) => n === 'node_modules' || n.startsWith('.'), max: 20_000 });
    const missing = new Map<string, { cps: Set<number>; files: Set<string> }>();
    // From JS/JSON only: bundles escape non-ASCII, so UI text and Unicode tables (React's, regexes)
    // look the same. Reported as a note; prerendered HTML is what fails the check.
    const scripted = new Map<string, { cps: Set<number>; files: Set<string> }>();
    type PageJson = { faces: Record<string, string>; fallback?: Record<string, string> };
    const pageChars = (pg: PageJson) => new Set([...Object.values(pg.faces), ...Object.values(pg.fallback ?? {})].flatMap((r) => [...rangeSet(r)]));
    const allSeen = new Set(Object.values(o.usage?.pages ?? {}).flatMap((pg) => [...pageChars(pg as PageJson)]));
    for (const rel of files) {
      let text: string;
      try { if (statSync(join(outDir, rel)).size > 5_000_000) continue; text = readFileSync(join(outDir, rel), 'utf8'); } catch { continue; }
      textFiles++;
      const isHtml = /\.html?$/i.test(rel);
      // Space separators and invisible format characters never decide a subset.
      const chars = new Set([...(isHtml ? htmlText(text) : scriptStrings(text))].filter((ch) => !/[\p{Z}\p{Cf}\p{Cc}]/u.test(ch)).map((c) => c.codePointAt(0)!).filter((c) => !allow.has(c)));
      // Faces drawn on this page (from the audit); unknown pages and scripts: every face.
      const pg = isHtml ? o.usage?.pages[pageOf(rel)] : undefined;
      const drawn = pg ? facts.filter((f) => pg.faces[f.e.id]) : facts;
      // Characters the audit already saw (drawn by some face, or falling back) aren't new content.
      const seen = pg ? pageChars(pg) : allSeen;
      for (const c of chars) {
        if (seen.has(c)) continue;
        if (drawn.some((f) => f.kept.has(c))) continue;
        for (const f of drawn) {
          if (!f.source?.cmap.has(c) || f.kept.has(c)) continue;
          const into = isHtml ? missing : scripted;
          const m = into.get(f.e.id) ?? into.set(f.e.id, { cps: new Set(), files: new Set() }).get(f.e.id)!;
          m.cps.add(c);
          m.files.add(relative(root, join(outDir, rel)).split(sep).join('/'));
        }
      }
    }
    for (const [id, m] of scripted) {
      const f = facts.find((x) => x.e.id === id)!;
      const cps = [...m.cps].filter((c) => !missing.get(id)?.cps.has(c)).sort((a, b) => a - b);
      if (cps.length) notes.push(`${f.e.family}: strings in ${[...m.files].slice(0, 2).join(', ')}${m.files.size > 2 ? ` and ${m.files.size - 2} more` : ''} have ${show(cps)}, outside its subsets; if any of them render, rerun (allowChars silences the rest)`);
    }
    for (const [id, m] of missing) {
      const f = facts.find((x) => x.e.id === id)!;
      const cps = [...m.cps].sort((a, b) => a - b);
      const lazy = cps.every((c) => f.rest.has(c));
      add({
        kind: 'chars', severity: lazy ? 'warning' : 'error', id, file: [...m.files][0],
        message: `${f.e.family}: ${show(cps)} ${lazy ? 'would load the rest file' : 'would render in a fallback font'} (in ${[...m.files].slice(0, 3).join(', ')}${m.files.size > 3 ? ` and ${m.files.size - 3} more` : ''})`,
      });
    }
  }

  return {
    ok: !issues.some((i) => o.strict || i.severity === 'error'), issues, command: rerunCommand(root, manifest.fontphobia),
    checked: { entries: facts.length, outputs, styleFiles: styleFiles.size, textFiles }, notes,
  };
}

export function formatCheck(r: CheckResult): string {
  const L: string[] = [];
  const errors = r.issues.filter((i) => i.severity === 'error'), warnings = r.issues.filter((i) => i.severity === 'warning');
  if (!r.issues.length) L.push(`fontphobia: subsets are up to date (${r.checked.entries} face(s), ${r.checked.outputs} file(s), ${r.checked.textFiles} built file(s) read)`);
  else {
    if (errors.length) {
      L.push(`fontphobia: subsets are out of date (${errors.length} reason(s)):`);
      for (const i of errors) L.push(`  - ${i.message}`);
    }
    if (warnings.length) {
      L.push(errors.length ? 'Also, these render correctly but download more than they should:' : `fontphobia: the site renders as built, but ${warnings.length === 1 ? 'this downloads' : 'these download'} more than ${warnings.length === 1 ? 'it' : 'they'} should${r.ok ? '' : ' (strict)'}:`);
      for (const i of warnings) L.push(`  - ${i.message}`);
    }
    L.push(`Run: ${r.command}`);
  }
  for (const n of r.notes) L.push(`  note: ${n}`);
  return L.join('\n');
}

/**
 * Exact mode (§12, `check --url`): compare a fresh crawl's usage with the written files. Every
 * character a generated face drew must be in its core or extended file, every feature it used must
 * be kept, and every axis value it rendered must be inside the files' ranges.
 */
export async function checkUsage(root: string, usage: UsageFileJson, o: { strict?: boolean } = {}): Promise<CheckResult> {
  const manifest = readManifest(root);
  if (!manifest || !Object.keys(manifest.entries).length) return { ok: true, issues: [], command: '', checked: { entries: 0, outputs: 0, styleFiles: 0, textFiles: 0 }, notes: ['no fontphobia.manifest.json: nothing has been built to check'] };
  const issues: CheckIssue[] = [];
  let outputs = 0;
  for (const e of Object.values(manifest.entries).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const face = usage.faces[e.id];
    if (!face) continue; // not drawn on the crawled pages
    const kept = new Set<number>(), rest = new Set<number>();
    const outs: FontFacts[] = [];
    for (const o of e.outputs) {
      outputs++;
      for (const c of rangeSet(o.unicodeRange)) (o.role === 'rest' ? rest : kept).add(c);
      const p = join(root, o.file);
      if (existsSync(p)) outs.push(await fontFacts(new Uint8Array(readFileSync(p))));
    }
    const missing = [...rangeSet(face.chars)].filter((c) => !kept.has(c));
    const lazy = missing.every((c) => rest.has(c));
    if (missing.length) issues.push({ kind: 'chars', severity: lazy ? 'warning' : 'error', id: e.id, message: `${e.family}: ${show(missing)} drawn on ${face.pages.length} page(s) ${lazy ? 'came from the rest file' : "aren't in any of its files"}` });
    const have = new Set(outs.flatMap((x) => [...x.features]));
    // Only features the source has: CSS can ask for small caps a font doesn't have (Chrome synthesizes them).
    const srcPath = join(root, e.source.file);
    const srcFeatures = existsSync(srcPath) ? (await fontFacts(new Uint8Array(readFileSync(srcPath)))).features : new Set<string>();
    const dropped = face.features.filter((t) => srcFeatures.has(t) && !have.has(t));
    if (outs.length && dropped.length) issues.push({ kind: 'feature', severity: 'error', id: e.id, message: `${e.family}: the site uses ${dropped.map((t) => `'${t}'`).join(', ')}, which its subsets don't keep` });
    for (const [tag, vals] of Object.entries(face.rendered.axes ?? {})) {
      const a = outs[0]?.axes.find((x) => x.tag === tag);
      const out = vals.filter((v) => (a ? v < a.min || v > a.max : e.plan.axes?.[tag] !== undefined));
      if (out.length) issues.push({ kind: 'axis', severity: 'error', id: e.id, message: `${e.family}: ${tag} ${out.join(', ')} rendered, outside its subsets (${a ? `${a.min}–${a.max}` : 'axis pinned'})` });
    }
  }
  return { ok: !issues.some((i) => o.strict || i.severity === 'error'), issues, command: rerunCommand(root, manifest.fontphobia), checked: { entries: Object.keys(manifest.entries).length, outputs, styleFiles: 0, textFiles: 0 }, notes: [] };
}
