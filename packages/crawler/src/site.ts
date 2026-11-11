// Getting the site to crawl (§7.1), shared by audit and verify: --url, --dist, --start-cmd, or what
// the framework profile finds, building first when there is no output or it is stale and the caller agrees.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { join } from 'node:path';
import { buildAge, buildCommand, detectProject, findSite, KEPT_OUTPUT, type BuildAge, type Project, type SiteSource } from '@fontphobia/core';
import { isolatedCopy, keepOutput, type Copy } from './isolate.ts';
import { serveStatic } from './serve.ts';
import { runCommand, startServer } from './server.ts';

export interface SiteOptions {
  dist?: string;
  url?: string;
  buildCmd?: string;
  startCmd?: string;
  /** Rebuild even when output exists. */
  rebuild?: boolean;
  /** Build in the project itself: it already is a throwaway copy (the worktree baseline). */
  inPlace?: boolean;
  /** Called when source files changed after the existing build. Resolve true to rebuild first. */
  onStale?: (age: BuildAge) => boolean | Promise<boolean>;
}

export interface OpenSite {
  mode: 'static' | 'server' | 'url';
  /** Origin (and base path) with a trailing slash. */
  base: string;
  site?: SiteSource;
  /** The build command, when this run built the site. */
  built?: string;
  /** Age of the existing build that is served. */
  age?: BuildAge;
  /** The project root the served output belongs to: the project, or the copy it was built in. */
  root: string;
  /** Built in a copy: move its output into .fontphobia/output/ (call before stop). */
  keepOutput?: () => void;
  stop(): Promise<void>;
}

/** "5 min ago", for logs and the report. */
export function since(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** The build output in `p`: `dist` (relative to the root) when given, else what the profile finds. */
function outputIn(p: Project, dist: string | undefined): SiteSource | undefined {
  if (dist === undefined) return findSite(p);
  const dir = join(p.root, dist);
  return isDir(dir) ? { mode: 'static', dir, spaFallback: p.profile.spaFallback, reason: '--dist' } : undefined;
}

/** The static output kept from fontphobia's last build in a copy, if nothing changed since. */
function keptSite(project: Project, dist: string | undefined): SiteSource | undefined {
  const root = join(project.root, KEPT_OUTPUT);
  if (!existsSync(root) || dist === '') return undefined; // --dist . is the project itself
  const site = outputIn({ ...project, root }, dist);
  if (site?.mode !== 'static') return undefined; // a server would run from the copy, which is gone
  const age = buildAge(project, site);
  return age && !age.newer ? { ...site, reason: `${KEPT_OUTPUT} (fontphobia's last build)` } : undefined;
}

export async function openSite(o: SiteOptions, project: Project, log: (m: string) => void): Promise<OpenSite> {
  const root = project.root;
  let site: SiteSource | undefined;
  let built: string | undefined;
  let age: BuildAge | undefined;
  let copy: Copy | undefined;
  if (o.url) return { mode: 'url', base: o.url.replace(/\/?$/, '/'), root, stop: async () => {} };
  // --dist says where the output is; it's built like the profile's output when there's a build command.
  // Outside the project, a build in a copy can't make it: it's served as it is.
  const dist = o.dist ? relative(root, resolve(root, o.dist)).split(sep).join('/') : undefined;
  const inside = dist !== undefined && !/^\.\.(\/|$)/.test(dist) && !isAbsolute(dist);
  if (o.dist && !(inside && (o.buildCmd ?? buildCommand(project)))) {
    site = { mode: 'static', dir: resolve(root, o.dist), spaFallback: project.profile.spaFallback, reason: '--dist' };
    if (!isDir(site.dir!)) throw new Error(`${site.dir} (--dist) is not a directory${inside ? ', and there is no build command to make it. Pass --build-cmd.' : ''}`);
    age = buildAge(project, site);
    if (age?.newer) log(`warning: ${age.newer.file}${age.newer.count > 1 ? ` and ${age.newer.count - 1} other file(s)` : ''} changed after ${age.output} was built (${since(age.builtAt)})`);
  } else if (o.startCmd && !o.dist) site = { mode: 'server', server: { cmd: o.startCmd, when: '', cwd: root }, reason: '--start-cmd' };
  else {
    site = o.rebuild ? undefined : outputIn(project, dist);
    // fontphobia's own last build (made in a copy, kept in .fontphobia/output) when it's newer than
    // every source and the project's output isn't: no rebuild on every run.
    const kept = o.rebuild || o.inPlace ? undefined : keptSite(project, dist);
    if (kept && (!site || buildAge(project, site)?.newer)) { site = kept; log(`using fontphobia's last build (${KEPT_OUTPUT}), newer than every source`); }
    if (site) {
      age = buildAge(project, site);
      if (age?.newer) {
        const ago = since(age.builtAt);
        const what = `${age.newer.file}${age.newer.count > 1 ? ` and ${age.newer.count - 1} other file(s)` : ''}`;
        if (await o.onStale?.(age)) { log(`${what} changed after ${age.output} was built (${ago}); rebuilding`); site = undefined; age = undefined; }
        else log(`warning: ${what} changed after ${age.output} was built (${ago}). Crawling the existing build; pass --rebuild to build first.`);
      }
    }
    if (!site) {
      const cmd = o.buildCmd ?? buildCommand(project);
      if (!cmd) throw new Error(`No build output found for ${project.profile.name} (looked in ${project.profile.output.join(', ') || 'nothing'}) and no build script. Pass --dist, --build-cmd, --start-cmd or --url.`);
      // In a throwaway copy: a build may write more than its output (data fetched into tracked files).
      copy = o.inPlace ? undefined : await isolatedCopy(root, log);
      const where = copy ? detectProject(copy.root) : project;
      log(`building: ${cmd}`);
      const r = await runCommand(cmd, where.root);
      if (r.code !== 0) { await copy?.remove(); throw new Error(`\`${cmd}\` failed (exit ${r.code}):\n${r.output.trim().slice(-3000)}`); }
      built = cmd;
      site = outputIn(where, dist);
      if (!site) { await copy?.remove(); throw new Error(dist !== undefined ? `\`${cmd}\` finished, but ${o.dist} (--dist) is not a directory.` : `\`${cmd}\` finished, but no output was found for ${project.profile.name} (looked in ${project.profile.output.join(', ')}). Pass --dist or --start-cmd.`); }
    }
  }
  // What a build in a copy leaves for later runs (.fontphobia/output/): the output it served.
  const outputs = dist !== undefined ? [dist] : project.profile.output;
  if (site.mode === 'static') {
    const s = await serveStatic(site.dir!, { spaFallback: site.spaFallback });
    log(`serving ${site.dir} (${site.reason})`);
    return { mode: 'static', base: s.url, site, built, age, root: copy?.root ?? root, keepOutput: copy && (() => keepOutput(copy!.root, root, outputs)), stop: async () => { await s.close(); await copy?.remove(); } };
  }
  log(`starting: ${site.server!.cmd}`);
  const s = await startServer(site.server!.cmd, { cwd: site.server!.cwd, env: site.server!.env }).catch(async (e) => { await copy?.remove(); throw e; });
  log(`server at ${s.url}`);
  return { mode: 'server', base: s.url.replace(/\/?$/, '/'), site, built, age, root: copy?.root ?? root, keepOutput: copy && (() => keepOutput(copy!.root, root, outputs)), stop: async () => { await s.stop(); await copy?.remove(); } };
}
