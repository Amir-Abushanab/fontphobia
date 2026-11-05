// Builds run in a throwaway copy of the project, never in it: a site's build can do more than write
// its output (fetch data into tracked files, bump caches), and fontphobia should change nothing but
// what it means to change. The copy is a git worktree at HEAD with the working tree's changes laid
// over it (so it builds exactly what's on disk), or a plain copy outside git. It lives in
// .fontphobia/tmp/ (ignored), on the project's own disk, so node_modules can be hard-linked in: every
// real path stays inside the copy, which bundlers that compile dependencies' source need (Astro's
// .astro components, Turbopack), without the space or time of a copy.
import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ensureFontphobiaDir, KEPT_OUTPUT } from '@fontphobia/core';

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
 * The same tree with every file hard-linked (copied where the disk can't link) and every link kept.
 * A link to an absolute path inside `from` (pnpm's junctions on Windows) points into `to` instead.
 */
export function linkTree(from: string, to: string, top = { from: realpathSync.native(from), to }) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isSymbolicLink()) {
      let target = readlinkSync(a);
      if (isAbsolute(target)) {
        // Compared as real paths (macOS: /var is /private/var).
        let real: string | undefined;
        try { real = realpathSync.native(target); } catch { /* dangling */ }
        if (real && (real === top.from || real.startsWith(top.from + sep))) target = join(top.to, relative(top.from, real));
      }
      let dir = false;
      try { dir = statSync(a).isDirectory(); } catch { /* dangling */ }
      symlinkSync(target, b, dir ? 'junction' : 'file');
    } else if (e.isDirectory()) linkTree(a, b, top);
    else { try { linkSync(a, b); } catch { copyFileSync(a, b); } }
  }
}

/** Dependencies aren't in git: the installed ones, hard-linked in (see the top of this file). */
export function linkDependencies(pairs: [from: string, to: string][]) {
  for (const [from, to] of pairs) {
    const nm = join(from, 'node_modules');
    if (!existsSync(nm) || existsSync(join(to, 'node_modules'))) continue;
    linkTree(nm, join(to, 'node_modules'));
  }
}

/** A fresh folder in .fontphobia/tmp/ for a throwaway copy (leftovers of crashed runs older than a day go). */
export function scratch(root: string, prefix: string): string {
  const base = join(ensureFontphobiaDir(root), 'tmp');
  mkdirSync(base, { recursive: true });
  for (const n of readdirSync(base)) { try { if (Date.now() - statSync(join(base, n)).mtimeMs > 86_400_000) rmSync(join(base, n), { recursive: true, force: true }); } catch { /* in use */ } }
  return mkdtempSync(join(base, prefix));
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
export async function isolatedCopy(root: string, log: (m: string) => void): Promise<Copy> {
  const g = await gitTop(root);
  const dir = scratch(root, 'build-');
  if (!g) {
    const wroot = join(dir, 'project');
    mkdirSync(wroot);
    for (const n of readdirSync(root)) if (!NOT_COPIED.has(n)) cpSync(join(root, n), join(wroot, n), { recursive: true, verbatimSymlinks: true });
    linkDependencies([[root, wroot]]);
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
    linkDependencies([[top, dir], [root, wroot]]);
    log(`building in a git worktree of the working tree (${relative(root, dir).split(sep).join('/')})`);
    return { root: wroot, remove };
  } catch (e) {
    await remove();
    throw e;
  }
}

/**
 * The output of a build made in a copy, moved to .fontphobia/output/ before the copy goes: build
 * reads what frameworks emitted there (the font files and CSS an eject takes over). Caches aren't kept.
 */
export function keepOutput(copyRoot: string, root: string, dirs: string[]) {
  const dest = join(root, KEPT_OUTPUT);
  rmSync(dest, { recursive: true, force: true });
  for (const d of new Set(dirs.map((x) => x.split('/')[0]!).filter((x) => x && x !== '.'))) {
    if (!existsSync(join(copyRoot, d))) continue;
    mkdirSync(dest, { recursive: true });
    renameSync(join(copyRoot, d), join(dest, d));
    for (const cache of ['cache', '.cache']) rmSync(join(dest, d, cache), { recursive: true, force: true });
  }
}

/** The project's own output was crawled: an earlier kept output would be stale. */
export const clearKeptOutput = (root: string) => rmSync(join(root, KEPT_OUTPUT), { recursive: true, force: true });
