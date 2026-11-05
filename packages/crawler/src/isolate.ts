// Builds run in a throwaway copy of the project, never in it: a site's build can do more than write
// its output (fetch data into tracked files, bump caches), and fontphobia should change nothing but
// what it means to change. The copy is a git worktree at HEAD with the working tree's changes laid
// over it (so it builds exactly what's on disk), or a plain copy outside git.
import { execFile } from 'node:child_process';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { Project } from '@fontphobia/core';

export const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile('git', args, { cwd, maxBuffer: 64 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`)) : resolve(stdout)));
});

/** The repository's top and the project's path inside it, or undefined outside git. */
export async function gitTop(root: string): Promise<{ top: string; rel: string } | undefined> {
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
    // git reports the real, long path (macOS: /var is /private/var; Windows: no 8.3 names like RUNNER~1).
    return { top, rel: relative(realpathSync.native(top), realpathSync.native(root)).split(sep).join('/') };
  } catch { return undefined; }
}

/** `git status --porcelain -z` as paths, with what happened to each. */
export async function gitChanges(top: string): Promise<{ path: string; deleted: boolean }[]> {
  const status = (await git(top, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const out: { path: string; deleted: boolean }[] = [];
  for (let i = 0; i < status.length; i++) {
    const entry = status[i]!;
    if (entry[0] === 'R' || entry[0] === 'C') { out.push({ path: status[i + 1]!, deleted: entry[0] === 'R' }); i++; } // the old path comes next
    out.push({ path: entry.slice(3), deleted: entry[0] === 'D' || entry[1] === 'D' });
  }
  return out;
}

/**
 * Dependencies aren't in git: reuse the installed ones. Turbopack (Next 16's default) won't resolve
 * through a node_modules that links outside the project, so for Next they're cloned (copy-on-write
 * on APFS, btrfs and XFS; a plain copy elsewhere), keeping pnpm's own links.
 */
export function linkDependencies(pairs: [from: string, to: string][], project: Project) {
  for (const [from, to] of pairs) {
    const nm = join(from, 'node_modules');
    if (!existsSync(nm) || existsSync(join(to, 'node_modules'))) continue;
    if (project.profile.id === 'next') cpSync(nm, join(to, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    else symlinkSync(nm, join(to, 'node_modules'), 'junction');
  }
}

/** Ignored files a build commonly reads: `.env`, `.env.local`, `.env.production`… at the project's top level. */
const envFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => /^\.env(\..+)?$/.test(n) && lstatSync(join(dir, n)).isFile()) : []);

export interface Copy {
  /** The project's root inside the copy. */
  root: string;
  remove(): Promise<void>;
}

/** Never copied outside git: dependencies (linked instead), VCS data, fontphobia's own folder. */
const NOT_COPIED = new Set(['node_modules', '.git', '.fontphobia']);

/** A copy of the project as it is on disk, to build in. */
export async function isolatedCopy(root: string, detect: (dir: string) => Project, log: (m: string) => void): Promise<Copy> {
  const g = await gitTop(root);
  const dir = mkdtempSync(join(tmpdir(), 'fontphobia-build-'));
  if (!g) {
    const wroot = join(dir, 'project');
    cpSync(root, wroot, { recursive: true, verbatimSymlinks: true, filter: (src) => !NOT_COPIED.has(src.slice(root.length + 1).split(sep)[0] ?? '') });
    linkDependencies([[root, wroot]], detect(wroot));
    log(`building in a copy of the project (${wroot})`);
    return { root: wroot, remove: async () => { rmSync(dir, { recursive: true, force: true }); } };
  }
  const { top, rel } = g;
  await git(top, ['worktree', 'add', '--detach', dir, 'HEAD']);
  const remove = async () => {
    await git(top, ['worktree', 'remove', '--force', dir]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    await git(top, ['worktree', 'prune']).catch(() => {});
  };
  try {
    // The working tree's changes, committed or not, so the copy builds what's on disk.
    for (const c of await gitChanges(top)) {
      const to = join(dir, c.path);
      if (c.deleted || !existsSync(join(top, c.path))) { rmSync(to, { recursive: true, force: true }); continue; }
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(top, c.path), to, { recursive: true, verbatimSymlinks: true });
    }
    const wroot = rel ? join(dir, rel) : dir;
    for (const [from, to] of [[top, dir], [root, wroot]] as const) for (const n of envFiles(from)) if (!existsSync(join(to, n))) cpSync(join(from, n), join(to, n));
    linkDependencies([[top, dir], [root, wroot]], detect(wroot));
    log(`building in a git worktree of the working tree (${dir})`);
    return { root: wroot, remove };
  } catch (e) {
    await remove();
    throw e;
  }
}
