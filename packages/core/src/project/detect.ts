// Project detection (§7.1): framework profile, build output, server, routes. File system only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { GENERIC, PROFILES, type Profile, type ServerSpec } from './profiles.ts';

export interface Project {
  root: string;
  pkg?: { name?: string; scripts?: Record<string, string>; packageManager?: string };
  deps: Set<string>;
  profile: Profile;
  /** Every profile that matched, most specific first. */
  matched: Profile[];
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'deno';
}

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; }
}

const has = (root: string, alts: string) => alts.split('|').some((f) => existsSync(join(root, f)));

export function detectProject(root: string): Project {
  const pkg = readJson(join(root, 'package.json'));
  const deps = new Set<string>(Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies, ...pkg?.optionalDependencies }));
  const matched = PROFILES.filter((p) =>
    (p.deps ?? []).every((d) => d.split('|').some((x) => deps.has(x))) && (p.files ?? []).every((f) => has(root, f)) && (p.deps?.length || p.files?.length),
  ).toSorted((a, b) => b.priority - a.priority);
  const pm = pkg?.packageManager?.split('@')[0];
  const packageManager = (['pnpm', 'npm', 'yarn', 'bun', 'deno'].includes(pm) ? pm
    : existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')) ? 'bun'
    : existsSync(join(root, 'deno.json')) || existsSync(join(root, 'deno.jsonc')) ? 'deno' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm') as Project['packageManager'];
  return { root, pkg, deps, profile: matched[0] ?? GENERIC, matched, packageManager };
}

/** Expand one `*` level per segment. */
export function expandPattern(root: string, pattern: string): string[] {
  const parts = pattern.split('/');
  let cur = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const dir of cur) {
      if (part === '*') {
        try { for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') next.push(join(dir, e.name)); } catch { /* none */ }
      } else if (part === '.') next.push(dir);
      else if (existsSync(join(dir, part))) next.push(join(dir, part));
    }
    cur = next;
  }
  return cur.toSorted();
}

export function listFiles(dir: string, pred: (rel: string) => boolean, opts: { skip?: (rel: string, name: string) => boolean; max?: number } = {}): string[] {
  const out: string[] = [];
  const max = opts.max ?? 50_000;
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (out.length >= max) return;
      const abs = join(d, e.name);
      const rel = relative(dir, abs).split(sep).join('/');
      if (opts.skip?.(rel, e.name)) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && pred(rel)) out.push(rel);
      else if (e.isSymbolicLink()) { try { const s = statSync(abs); if (s.isDirectory()) walk(abs); else if (pred(rel)) out.push(rel); } catch { /* broken */ } }
    }
  };
  walk(dir);
  return out;
}

const htmlIn = (dir: string) => listFiles(dir, (r) => r.endsWith('.html'), { skip: (_r, n) => n === 'node_modules', max: 1 }).length > 0;

export interface SiteSource {
  mode: 'static' | 'server';
  /** Static: the output directory. */
  dir?: string;
  /** Server: the command and where to run it. */
  server?: ServerSpec & { cmd: string; cwd: string };
  spaFallback?: boolean;
  /** Why this was chosen, for the report. */
  reason: string;
}

/** Pick static output or a server from what the build left behind. Undefined: nothing built yet. */
export function findSite(p: Project): SiteSource | undefined {
  const statics = p.profile.output.flatMap((o) => expandPattern(p.root, o)).filter((d) => statSync(d).isDirectory() && htmlIn(d));
  const servers = (p.profile.server ?? []).flatMap((s) => {
    const hits = expandPattern(p.root, s.when);
    if (!hits.length) return [];
    // Resolve `*` in the command from the matched path (Angular's dist/<project>/…).
    let cmd = s.cmd;
    if (s.when.includes('*')) {
      const rel = relative(p.root, hits[0]!).split(sep).join('/');
      const re = new RegExp('^' + s.when.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('([^/]+)') + '$');
      const m = rel.match(re);
      if (m) cmd = cmd.replace('*', m[1]!);
    }
    return [{ ...s, cmd, cwd: join(p.root, s.cwd ?? '.') }];
  });
  if (statics.length && (p.profile.preferStatic || !servers.length)) {
    return { mode: 'static', dir: statics[0], spaFallback: p.profile.spaFallback, reason: `${relative(p.root, statics[0]!) || '.'} has HTML` };
  }
  if (servers.length) return { mode: 'server', server: servers[0], reason: `${servers[0]!.when} exists` };
  return undefined;
}

export interface BuildAge {
  /** Newest file in the build output (ms since epoch). */
  builtAt: number;
  /** Where that was measured, relative to the root. */
  output: string;
  /** Source files modified after the build: the newest one and how many. */
  newer?: { file: string; mtime: number; count: number };
}

// Never source: dependencies, caches, framework build dirs, fontphobia's own files.
const NOT_SOURCE = new Set(['node_modules', '.git', '.hg', '.svn', '.fontphobia', 'coverage']);
const SLACK_MS = 1000;

function newestIn(dir: string, max = 50_000): number {
  let newest = 0, n = 0;
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n++ > max) return;
      const abs = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); }
      else { try { newest = Math.max(newest, statSync(abs).mtimeMs); } catch { /* gone */ } }
    }
  };
  walk(dir);
  return newest;
}

/**
 * How old the build output is, and which source files changed after it (§7.1). A heuristic:
 * a fresh clone resets modification times, and CMS content changes without touching files.
 * Undefined when there's nothing to compare (no output, or the output is the project itself).
 */
export function buildAge(p: Project, site: SiteSource): BuildAge | undefined {
  let output: string | undefined, builtAt = 0;
  if (site.mode === 'static' && site.dir && site.dir !== p.root) { output = site.dir; builtAt = newestIn(site.dir); }
  else if (site.mode === 'server' && site.server?.when) {
    const hit = expandPattern(p.root, site.server.when)[0];
    if (hit) { output = hit; try { builtAt = statSync(hit).isDirectory() ? newestIn(hit) : statSync(hit).mtimeMs; } catch { /* gone */ } }
  }
  if (!output || !builtAt) return undefined;
  // Build artifacts: every output and server path the profile knows, at their first directory level
  // under the root, plus dot-directories (.next, .astro, .output, .svelte-kit, …) except source ones.
  const skip = new Set<string>();
  for (const o of p.profile.output) for (const d of expandPattern(p.root, o)) if (d !== p.root) skip.add(relative(p.root, d).split(sep).join('/'));
  for (const s of p.profile.server ?? []) { const top = s.when.split('/')[0]!; if (top !== '*') skip.add(top); }
  skip.add(relative(p.root, output).split(sep).join('/'));
  const outputs = [...skip];
  const isArtifact = (rel: string) => outputs.some((o) => rel === o || rel.startsWith(o + '/'));
  let newer: BuildAge['newer'];
  let count = 0, n = 0;
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n++ > 50_000) return;
      const abs = join(d, e.name);
      const rel = relative(p.root, abs).split(sep).join('/');
      if (NOT_SOURCE.has(e.name) || isArtifact(rel)) continue;
      if (e.isDirectory()) {
        // .vitepress holds config and theme (its dist and cache are outputs, skipped above).
        if (e.name.startsWith('.') && e.name !== '.vitepress') continue;
        if (rel.endsWith('.vitepress/cache')) continue;
        walk(abs);
      } else if (e.isFile() && !e.name.startsWith('fontphobia.config.') && !e.name.endsWith('.log')) {
        let m: number;
        try { m = statSync(abs).mtimeMs; } catch { continue; }
        if (m > builtAt + SLACK_MS) {
          count++;
          if (!newer || m > newer.mtime) newer = { file: rel, mtime: m, count: 0 };
        }
      }
    }
  };
  walk(p.root);
  if (newer) newer.count = count;
  return { builtAt, output: relative(p.root, output).split(sep).join('/') || '.', newer };
}

/** The build command: config, then the profile's own, then the package's `build` script. */
export function buildCommand(p: Project): string | undefined {
  if (p.profile.build) return p.profile.build;
  if (!p.pkg?.scripts?.build) return undefined;
  return p.packageManager === 'npm' ? 'npm run build' : p.packageManager === 'deno' ? 'deno task build' : `${p.packageManager} run build`;
}

/** Paths a static output serves as pages: dir/index.html → /dir/, x.html → /x (clean URLs where x/ doesn't exist). */
export function htmlPages(dir: string): string[] {
  return listFiles(dir, (r) => r.endsWith('.html'), { skip: (_r, n) => n === 'node_modules' || n.startsWith('.') })
    .map((r) => (r === 'index.html' ? '/' : r.endsWith('/index.html') ? '/' + r.slice(0, -'index.html'.length) : '/' + r))
    .filter((p) => !/^\/(_next|_nuxt|_astro|assets|static)\//.test(p))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Route lists the build left on disk (§7.1.1 "Route list"). Dynamic routes come back separately. */
export function routesFromFiles(p: Project): { routes: string[]; dynamic: string[]; sources: string[] } {
  const routes = new Set<string>(), dynamic = new Set<string>(), sources: string[] = [];
  const add = (r: string, src: string) => {
    if (!r.startsWith('/')) r = '/' + r;
    if (/\[|\$|\/:|\*/.test(r)) dynamic.add(r); else routes.add(r);
    if (!sources.includes(src)) sources.push(src);
  };
  for (const src of p.profile.routes) {
    switch (src) {
      case 'next-manifest': {
        const pre = readJson(join(p.root, '.next/prerender-manifest.json'));
        for (const r of Object.keys(pre?.routes ?? {})) add(r, src);
        const rm = readJson(join(p.root, '.next/routes-manifest.json'));
        for (const r of rm?.staticRoutes ?? []) if (!r.page.startsWith('/_')) add(r.page, src);
        for (const r of rm?.dynamicRoutes ?? []) add(r.page, src);
        break;
      }
      case 'nuxt-meta': {
        const dir = join(p.root, '.output/public/_nuxt/builds/meta');
        if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).toSorted()) for (const r of readJson(join(dir, f))?.prerendered ?? []) add(r, src);
        break;
      }
      case 'angular-prerendered':
        for (const f of expandPattern(p.root, 'dist/*/prerendered-routes.json')) for (const r of Object.keys(readJson(f)?.routes ?? {})) add(r, src);
        break;
      case 'tanstack-route-tree': {
        const f = join(p.root, 'src/routeTree.gen.ts');
        if (!existsSync(f)) break;
        const t = readFileSync(f, 'utf8');
        const m = t.match(/fullPaths\s*:\s*([^\n]*)/);
        if (m) for (const r of m[1]!.matchAll(/'([^']*)'/g)) add(r[1]!, src);
        break;
      }
      case 'foldkit-build':
        for (const r of readJson(join(p.root, 'dist/server/foldkit.build.json'))?.prerendered ?? []) add(typeof r === 'string' ? r : r.path, src);
        break;
      case 'gatsby-page-data':
        for (const f of listFiles(join(p.root, 'public/page-data'), (r) => r.endsWith('page-data.json'))) {
          const d = readJson(join(p.root, 'public/page-data', f));
          if (d?.path && !d.path.startsWith('/dev-404')) add(d.path, src);
        }
        break;
      case 'astro-ssr-entry': {
        const f = join(p.root, 'dist/server/entry.mjs');
        if (!existsSync(f)) break;
        for (const m of readFileSync(f, 'utf8').matchAll(/"route":"([^"]+)"/g)) if (!m[1]!.startsWith('/_')) add(m[1]!, src);
        break;
      }
      default: break;
    }
  }
  return { routes: [...routes].toSorted(), dynamic: [...dynamic].toSorted(), sources };
}

/** `**` any depth, `*` one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const isGlob = (s: string) => /[*?]/.test(s);
