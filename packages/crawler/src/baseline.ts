// The worktree baseline (§10.3): "before" is HEAD built in a temporary git worktree, with
// fontphobia's blocks reverted there if they're already committed. It works for every adapter,
// where the overlay only knows how to swap `@font-face` rules back. The working tree may differ
// from HEAD only by fontphobia's own changes, so any other difference is content, not fonts.
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buildCommand, detectProject, LEGACY_MANIFEST_FILE, manifestPath, MANIFEST_FILE, revertProject, type Manifest } from '@fontphobia/core';
import { openSite, type OpenSite, type SiteOptions } from './site.ts';
import { git, linkDependencies } from './isolate.ts';

export interface Baseline { site: OpenSite; dir: string; reverted: boolean; stop(): Promise<void> }

/** Paths (relative to the project root) that fontphobia's build may have changed. */
function ownPaths(m: Manifest): (p: string) => boolean {
  const exact = new Set<string>([MANIFEST_FILE, LEGACY_MANIFEST_FILE]);
  for (const e of Object.values(m.entries)) {
    exact.add(e.stylesheet);
    for (const o of e.outputs) exact.add(o.file);
    for (const p of e.preloads ?? []) exact.add(p.file);
    if (e.next) exact.add(e.next.file);
  }
  for (const [file, ej] of Object.entries(m.ejects ?? {})) { exact.add(file); for (const i of ej.imports) exact.add(i.file); for (const x of ej.snippets ?? []) exact.add(x.file); for (const x of ej.files ?? []) exact.add(x); }
  for (const r of m.google ?? []) for (const f of r.files) exact.add(f);
  for (const r of m.options ?? []) exact.add(r.file);
  return (p) => exact.has(p) || p.startsWith('.fontphobia/');
}

export async function worktreeBaseline(root: string, manifest: Manifest, o: SiteOptions, log: (m: string) => void): Promise<Baseline> {
  if (o.url) throw new Error('The worktree baseline builds the site itself; it can\'t be used with --url');
  let top: string;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); } catch { throw new Error(`${root} isn't in a git repository; the worktree baseline builds HEAD. Use the overlay baseline (the default for css).`); }
  // git reports the real, long path (macOS: /var is /private/var; Windows: no 8.3 names like RUNNER~1).
  const rel = relative(realpathSync.native(top), realpathSync.native(root)).split(sep).join('/');
  const mine = ownPaths(manifest);

  // Uncommitted changes must all be fontphobia's, or "before" and "after" differ by more than fonts.
  const status = (await git(top, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const other: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const entry = status[i]!;
    const path = entry.slice(3);
    if (entry[0] === 'R' || entry[0] === 'C') i++; // renames carry the old path next
    const inProject = rel ? (path.startsWith(rel + '/') ? path.slice(rel.length + 1) : undefined) : path;
    if (inProject === undefined || !mine(inProject)) other.push(path);
  }
  if (other.length) {
    throw new Error(`The worktree baseline compares HEAD with your working tree, which has changes besides fontphobia's: ${other.slice(0, 5).join(', ')}${other.length > 5 ? ` and ${other.length - 5} more` : ''}. Commit or stash them first.`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'fontphobia-baseline-'));
  await git(top, ['worktree', 'add', '--detach', dir, 'HEAD']);
  const cleanup = async () => {
    await git(top, ['worktree', 'remove', '--force', dir]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    await git(top, ['worktree', 'prune']).catch(() => {});
  };
  try {
    const wroot = rel ? join(dir, rel) : dir;
    // HEAD may already have fontphobia's edits committed: put the original declarations back there.
    let reverted = false;
    if (existsSync(manifestPath(wroot))) {
      const r = revertProject(wroot, { write: true });
      if (r.problems.length) throw new Error(`Couldn't revert fontphobia's edits in the baseline: ${r.problems.join('; ')}`);
      reverted = true;
    }
    const project = detectProject(wroot);
    linkDependencies([[top, dir], [root, wroot]], project);
    const cmd = o.buildCmd ?? buildCommand(project);
    log(`baseline: HEAD in a git worktree${reverted ? ', fontphobia\'s committed edits reverted' : ''}${cmd ? `, building with ${cmd}` : ''}`);
    const site = await openSite({ dist: o.dist, buildCmd: o.buildCmd, startCmd: o.startCmd, rebuild: !!cmd && !o.dist && !o.startCmd, inPlace: true }, project, (m) => log(`baseline: ${m}`));
    return { site, dir: wroot, reverted, stop: async () => { await site.stop(); await cleanup(); } };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
