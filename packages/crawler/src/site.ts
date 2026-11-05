// Getting the site to crawl (§7.1), shared by audit and verify: --url, --dist, --start-cmd, or what
// the framework profile finds, building first when there is no output or it is stale and the caller agrees.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAge, buildCommand, detectProject, findSite, type BuildAge, type Project, type SiteSource } from '@fontphobia/core';
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

export async function openSite(o: SiteOptions, project: Project, log: (m: string) => void): Promise<OpenSite> {
  const root = project.root;
  let site: SiteSource | undefined;
  let built: string | undefined;
  let age: BuildAge | undefined;
  let copy: Copy | undefined;
  if (o.url) return { mode: 'url', base: o.url.replace(/\/?$/, '/'), root, stop: async () => {} };
  if (o.dist) site = { mode: 'static', dir: resolve(root, o.dist), spaFallback: project.profile.spaFallback, reason: '--dist' };
  else if (o.startCmd) site = { mode: 'server', server: { cmd: o.startCmd, when: '', cwd: root }, reason: '--start-cmd' };
  else {
    site = o.rebuild ? undefined : findSite(project);
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
      site = findSite(where);
      if (!site) { await copy?.remove(); throw new Error(`\`${cmd}\` finished, but no output was found for ${project.profile.name} (looked in ${project.profile.output.join(', ')}). Pass --dist or --start-cmd.`); }
    }
  }
  if (o.dist) {
    age = buildAge(project, site);
    if (age?.newer) log(`warning: ${age.newer.file}${age.newer.count > 1 ? ` and ${age.newer.count - 1} other file(s)` : ''} changed after ${age.output} was built (${since(age.builtAt)})`);
  }
  if (site.mode === 'static') {
    if (!existsSync(site.dir!) || !statSync(site.dir!).isDirectory()) { await copy?.remove(); throw new Error(`${site.dir} is not a directory`); }
    const s = await serveStatic(site.dir!, { spaFallback: site.spaFallback });
    log(`serving ${site.dir} (${site.reason})`);
    return { mode: 'static', base: s.url, site, built, age, root: copy?.root ?? root, keepOutput: copy && (() => keepOutput(copy!.root, root, project.profile.output)), stop: async () => { await s.close(); await copy?.remove(); } };
  }
  log(`starting: ${site.server!.cmd}`);
  const s = await startServer(site.server!.cmd, { cwd: site.server!.cwd, env: site.server!.env }).catch(async (e) => { await copy?.remove(); throw e; });
  log(`server at ${s.url}`);
  return { mode: 'server', base: s.url.replace(/\/?$/, '/'), site, built, age, root: copy?.root ?? root, keepOutput: copy && (() => keepOutput(copy!.root, root, project.profile.output)), stop: async () => { await s.stop(); await copy?.remove(); } };
}
