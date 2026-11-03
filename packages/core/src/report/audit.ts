// The audit report: terminal text and report.md, from usage.json plus crawl facts (§1.5, §7).
import { parseUnicodeRange, codePointsOf, formatUnicodeRange } from '../css/unicode-range.ts';

type UsageJson = {
  meta: { fontphobia: string; chrome: string; framework: string; mode: string; viewports: number[]; fontSizes: number[] };
  faces: Record<string, {
    family: string; descriptors: Record<string, string>; source: { adapter: string; file?: string; line?: number; fontFile?: string; note?: string };
    files: { url: string; bytes?: number }[]; chars: string; count: number; inserted: Record<string, string>; pages: string[];
    features: string[]; rendered: { weight?: number[]; axes?: Record<string, number[]> }; editable?: boolean; wordsTruncated?: boolean; local?: boolean;
  }>;
  pages: Record<string, {
    visits: string[]; bytes: number; fonts: { url: string; status: number; bytes: number; faces: string[] }[];
    preloads: { href: string; crossorigin: string | null; used: boolean }[]; fallback: Record<string, string>; disagreements: string[]; notes: string[];
  }>;
  unloaded: Record<string, { family: string; descriptors: Record<string, string>; sheet: string; urls: string[] }>;
  declarations?: { file: string; line: number; family: string; weight?: string; style?: string; files: string[]; manual?: string }[];
  offDom?: { file: string; line: number; kind: string }[];
};

export interface CrawlFacts {
  framework: { name: string; tier: 1 | 2 };
  mode: string;
  source: string;
  built?: string;
  build?: { at: string; output: string; newer?: { file: string; at: string; count: number } };
  pages: string[];
  failed: Record<string, string>;
  dynamicRoutes: string[];
  visits: number;
  viewports: number[];
  fontSizes: number[];
  durationMs: number;
}

export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

const sample = (ranges: string, max = 12) => {
  const cps: number[] = [];
  for (const c of codePointsOf(parseUnicodeRange(ranges))) { cps.push(c); if (cps.length > max) break; }
  const s = cps.slice(0, max).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(c)}`).join(', ');
  return cps.length > max ? s + ', …' : s;
};

export function faceLabel(f: UsageJson['faces'][string]): string {
  const d = f.descriptors;
  const parts = [f.family, (d['font-weight'] ?? '400').trim(), (d['font-style'] ?? 'normal').trim()];
  if (d['font-stretch']) parts.push(d['font-stretch'].trim());
  if (d['unicode-range']) {
    let r = d['unicode-range'].trim();
    try { r = formatUnicodeRange(parseUnicodeRange(r)); } catch { /* keep as written */ }
    const parts2 = r.split(', ');
    parts.push(parts2.length > 2 ? `(${parts2.slice(0, 2).join(', ')}, …)` : `(${r})`);
  }
  return parts.join(' ');
}

const sourceLabel = (s: UsageJson['faces'][string]['source']) =>
  `${s.adapter}${s.file ? ` ${s.file}:${s.line}` : ''}${s.note && s.adapter !== 'css' ? ` (${s.note})` : ''}`;

function table(rows: string[][], align: ('l' | 'r')[]): string[] {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (align[i] === 'r' ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join('  ').trimEnd());
}

const ago = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

/** "built 2 h ago" / "built just now", for the header. */
const buildNote = (c: CrawlFacts) => (c.built ? 'built just now' : c.build ? `built ${ago(c.build.at)}` : '');

export interface Finding { kind: string; text: string }

export function auditFindings(u: UsageJson, crawl: CrawlFacts): Finding[] {
  const out: Finding[] = [];
  const nw = crawl.build?.newer;
  if (nw) out.push({ kind: 'stale build', text: `${nw.file}${nw.count > 1 ? ` and ${nw.count - 1} other file(s)` : ''} changed after ${crawl.build!.output} was built (${ago(crawl.build!.at)}); this usage may miss new text. Run with --rebuild.` });
  const fallback = new Map<string, Set<string>>();
  for (const [p, pg] of Object.entries(u.pages)) for (const [fam, r] of Object.entries(pg.fallback)) {
    const k = `${fam}: ${sample(r, 8)}`;
    fallback.set(k, (fallback.get(k) ?? new Set()).add(p));
  }
  for (const [k, ps] of fallback) out.push({ kind: 'system fallback', text: `${k} renders in a system font today (the web font lacks it) on ${ps.size} page(s), e.g. ${[...ps][0]}` });
  // unicode-range slices (fontsource, Google) download only when a page needs them: one line per family.
  const slices = new Map<string, number>();
  for (const f of Object.values(u.unloaded)) if (f.descriptors['unicode-range']) slices.set(f.family, (slices.get(f.family) ?? 0) + 1);
  for (const [fam, n] of slices) out.push({ kind: 'unused slices', text: `${fam}: ${n} unicode-range slice(s) no page needs; they only download when one does, so they're left alone` });
  for (const [id, f] of Object.entries(u.unloaded)) {
    if (f.descriptors['unicode-range']) continue;
    const decl = u.declarations?.find((d) => d.family === f.family && f.urls.some((x) => d.files.some((y) => x.endsWith(y.split('/').pop()!))));
    out.push({ kind: 'never loaded', text: `${f.family} ${f.descriptors['font-weight'] ?? '400'} ${f.descriptors['font-style'] ?? 'normal'} (${id}) is declared${decl ? ` in ${decl.file}:${decl.line}` : f.sheet !== 'inline' ? ` in ${f.sheet}` : ''} but no page draws text with it; left alone` });
  }
  const preloadIssues = new Map<string, Set<string>>();
  for (const [p, pg] of Object.entries(u.pages)) for (const pl of pg.preloads) {
    if (!pl.used) preloadIssues.set(`${pl.href} is preloaded but no face uses it`, (preloadIssues.get(`${pl.href} is preloaded but no face uses it`) ?? new Set()).add(p));
    if (pl.crossorigin === null) preloadIssues.set(`${pl.href} is preloaded without crossorigin, so it downloads twice`, (preloadIssues.get(`${pl.href} is preloaded without crossorigin, so it downloads twice`) ?? new Set()).add(p));
  }
  for (const [t, ps] of preloadIssues) out.push({ kind: 'preload', text: `${t} (${ps.size} page(s))` });
  const bySource = new Map<string, Set<string>>();
  for (const f of Object.values(u.faces)) bySource.set(f.family, (bySource.get(f.family) ?? new Set()).add(f.source.adapter));
  for (const [fam, s] of bySource) if (s.size > 1) out.push({ kind: 'duplicate', text: `${fam} loads from more than one source: ${[...s].sort().join(', ')}` });
  const dis = new Set<string>();
  for (const pg of Object.values(u.pages)) for (const d of pg.disagreements) dis.add(d);
  for (const d of dis) out.push({ kind: 'cross-check', text: `Chrome drew text with ${d} where the CSS matching predicted another face; its characters were added to every candidate face` });
  for (const d of crawl.dynamicRoutes) out.push({ kind: 'routes', text: `${d} is a dynamic route with no crawled example: add sample paths to \`pages\`` });
  for (const [p, e] of Object.entries(crawl.failed)) out.push({ kind: 'failed', text: `${p}: ${e}` });
  for (const h of u.offDom ?? []) out.push({ kind: 'off-DOM', text: `${h.file}:${h.line} uses fonts outside the DOM (${h.kind}); those files keep working because outputs are new files` });
  for (const [id, f] of Object.entries(u.faces)) if (f.wordsTruncated) out.push({ kind: 'usage.json', text: `${id}: word list capped` });
  for (const [id, f] of Object.entries(u.faces)) if (f.source.adapter === 'unknown') out.push({ kind: 'source', text: `${id} (${f.files[0]?.url ?? f.family}): no declaration found in the repo` });
  const notes = new Set<string>();
  for (const pg of Object.values(u.pages)) for (const n of pg.notes) notes.add(n);
  for (const n of notes) out.push({ kind: 'note', text: n });
  return out;
}

export function formatAudit(u: UsageJson, crawl: CrawlFacts): string {
  const L: string[] = [];
  const sweep = crawl.fontSizes.length > 1 ? ` + font sizes ${crawl.fontSizes.filter((s) => s !== 16).join('/')}` : '';
  L.push(`fontphobia ${u.meta.fontphobia} · ${crawl.framework.name}${crawl.framework.tier === 2 ? ' (tier 2, best effort)' : ''} · ${crawl.mode} ${crawl.source}${buildNote(crawl) ? ` (${buildNote(crawl)})` : ''}`);
  L.push(`${crawl.pages.length} pages × ${crawl.viewports.length} viewports${sweep} · ${crawl.visits} visits · Chrome ${u.meta.chrome} · ${(crawl.durationMs / 1000).toFixed(1)} s`);
  L.push('');
  const faces = Object.entries(u.faces);
  const n = crawl.pages.length;
  if (faces.length) {
    L.push(...table([
      ['Face', 'Source', 'File', 'Chars', 'Pages'],
      ...faces.map(([, f]) => [faceLabel(f), sourceLabel(f.source), kb(Math.max(0, ...f.files.map((x) => x.bytes ?? 0))), String(f.count), `${f.pages.length}/${n}`]),
    ], ['l', 'l', 'r', 'r', 'r']));
  } else L.push('No web fonts are used.');
  L.push('');
  const pages = Object.entries(u.pages);
  const bytes = pages.map(([, p]) => p.bytes).sort((a, b) => a - b);
  if (pages.length) {
    const median = bytes[Math.floor((bytes.length - 1) / 2)]!;
    L.push(`Font bytes per page: median ${kb(median)}, max ${kb(bytes[bytes.length - 1]!)}`);
    const shown = pages.length > 15 ? [...pages].sort(([, a], [, b]) => b.bytes - a.bytes).slice(0, 15) : pages;
    L.push(...table([
      ['Page', 'Font bytes', 'Files', 'Preloads'],
      ...shown.map(([p, pg]) => [p, kb(pg.bytes), String(pg.fonts.filter((f) => f.status < 400).length), pg.preloads.length ? `${pg.preloads.length}${pg.preloads.some((x) => !x.used) ? ` (${pg.preloads.filter((x) => !x.used).length} unused)` : ''}` : '-']),
    ], ['l', 'r', 'r', 'r']).map((l) => '  ' + l));
    if (shown.length < pages.length) L.push(`  … ${pages.length - shown.length} more in report.md`);
  }
  const findings = auditFindings(u, crawl);
  if (findings.length) {
    L.push('');
    L.push('Findings');
    for (const f of findings) L.push(`  ${f.kind.padEnd(15)} ${f.text}`);
  }
  return L.join('\n');
}

export function auditMarkdown(u: UsageJson, crawl: CrawlFacts): string {
  const L: string[] = [];
  L.push(`# fontphobia audit`);
  L.push('');
  L.push(`fontphobia ${u.meta.fontphobia} · ${crawl.framework.name} · ${crawl.mode} \`${crawl.source}\`${crawl.build ? ` (built ${crawl.build.at})` : crawl.built ? ` (built by \`${crawl.built}\`)` : ''} · Chrome ${u.meta.chrome}`);
  L.push(`${crawl.pages.length} pages × viewports ${crawl.viewports.join(', ')} · font sizes ${crawl.fontSizes.join(', ')} · ${crawl.visits} visits`);
  L.push('');
  L.push('## Faces');
  L.push('');
  L.push('| Face | Source | Files | Characters | Features | Pages |');
  L.push('|---|---|---|---|---|---|');
  for (const [id, f] of Object.entries(u.faces)) {
    L.push(`| ${faceLabel(f)} \`${id}\` | ${sourceLabel(f.source)} | ${f.files.map((x) => `${x.url} (${kb(x.bytes ?? 0)})`).join('<br>')} | ${f.count} | ${f.features.join(' ') || '-'} | ${f.pages.length} |`);
  }
  const inserted = Object.entries(u.faces).filter(([, f]) => Object.keys(f.inserted).length);
  if (inserted.length) {
    L.push('');
    L.push('## Characters added by rules (§7.4)');
    L.push('');
    for (const [id, f] of inserted) for (const [rule, r] of Object.entries(f.inserted)) L.push(`- \`${id}\` ${rule}: ${sample(r, 10)}`);
  }
  L.push('');
  L.push('## Pages');
  L.push('');
  L.push('| Page | Font bytes | Files | Preloads |');
  L.push('|---|---|---|---|');
  for (const [p, pg] of Object.entries(u.pages)) {
    L.push(`| ${p} | ${kb(pg.bytes)} | ${pg.fonts.filter((f) => f.status < 400).map((f) => `${f.url.split('/').pop()} (${kb(f.bytes)})`).join('<br>') || '-'} | ${pg.preloads.map((x) => `${x.href.split('/').pop()}${x.used ? '' : ' (unused)'}${x.crossorigin === null ? ' (no crossorigin)' : ''}`).join('<br>') || '-'} |`);
  }
  const findings = auditFindings(u, crawl);
  if (findings.length) {
    L.push('');
    L.push('## Findings');
    L.push('');
    for (const f of findings) L.push(`- **${f.kind}**: ${f.text}`);
  }
  L.push('');
  L.push('Rerun with `pnpm dlx fontphobia audit`. Usage data: `.fontphobia/usage.json`.');
  return L.join('\n') + '\n';
}
