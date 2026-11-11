// Builds run in a throwaway copy of the project, never in it: a site's build can do more than write
// its output (fetch data into tracked files, bump caches), and fontphobia should change nothing but
// what it means to change. The copy is a git worktree at HEAD with the working tree's changes laid
// over it (so it builds exactly what's on disk), or a plain copy outside git or where git ignores the
// project. It lives in .fontphobia/tmp/ (ignored), on the project's own disk, so node_modules can be hard-linked in: every
// real path stays inside the copy, which bundlers that compile dependencies' source need (Astro's
// .astro components, Turbopack), without the space or time of a copy.
import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
/** Caches the next build makes again, left out of copies as a git worktree leaves them out. */
const CACHES = new Set(['.cache', '.turbo', '.next', '.nuxt', '.output', '.svelte-kit', '.astro', '.angular', '.docusaurus', '.tanstack', '.nitro']);

/** A plain copy of the project (outside git, or in a folder git ignores): every node_modules linked, caches left out. */
function plainCopy(root: string, wroot: string) {
  mkdirSync(wroot);
  const deps = existsSync(join(root, 'node_modules')) ? ['node_modules'] : [];
  const filter = (src: string) => { if (basename(src) !== 'node_modules') return true; deps.push(relative(root, src)); return false; };
  for (const n of readdirSync(root)) if (!NOT_COPIED.has(n) && !CACHES.has(n)) cpSync(join(root, n), join(wroot, n), { recursive: true, verbatimSymlinks: true, filter });
  const map = { from: realpathSync.native(root), to: wroot };
  for (const d of deps) linkTree(join(root, d), join(wroot, d), map);
}

const ignoredBy = (repo: string) => git(repo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).then((o) => o.split('\0').filter((p) => p && !/(^|\/)\.fontphobia\//.test(p)));

/**
 * A repository's files on disk into `copy`: submodules (empty folders in a new worktree) and installed
 * node_modules. `reach` says which folders' node_modules to link (all of them when it's left out).
 */
async function fillRepo(repo: string, copy: string, map: { from: string; to: string }, reach?: (dir: string) => boolean): Promise<string[]> {
  if (existsSync(join(repo, '.gitmodules'))) {
    for (const e of (await git(repo, ['ls-files', '-z', '--stage'])).split('\0')) {
      const sub = /^160000 \S+ \d\t(.+)$/s.exec(e)?.[1];
      if (!sub || !existsSync(join(repo, sub, '.git'))) continue; // not checked out here either
      const from = join(repo, sub), to = join(copy, sub);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      // Its files as they are on disk (copies: a build may write into them).
      for (const f of (await git(from, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0')) {
        let st;
        try { st = f && lstatSync(join(from, f)); } catch { continue; } // deleted
        if (!st || st.isDirectory()) continue; // a nested submodule, filled next
        mkdirSync(dirname(join(to, f)), { recursive: true });
        cpSync(join(from, f), join(to, f), { verbatimSymlinks: true });
      }
      await fillRepo(from, to, map);
    }
  }
  // Dependencies aren't in git: the installed node_modules (workspace packages have their own), hard-linked in.
  const ignored = await ignoredBy(repo);
  for (const p of ignored) if (/(^|\/)node_modules\/$/.test(p) && (!reach || reach(p.replace(/\/?node_modules\/$/, ''))) && !existsSync(join(copy, p))) linkTree(join(repo, p), join(copy, p), map);
  return ignored;
}

/** Workspace packages (paths in the repository) that `pkg` depends on through node_modules links. */
function workspaceDeps(top: string, realTop: string, pkg: string): string[] {
  let json;
  try { json = JSON.parse(readFileSync(join(top, pkg, 'package.json'), 'utf8')); } catch { return []; }
  const out: string[] = [];
  for (const name of Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.optionalDependencies, ...json.peerDependencies })) {
    // Where Node finds it: the package's node_modules, then each parent's up to the top (hoisted).
    for (let d = pkg; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
      const at = join(top, d, 'node_modules', name);
      if (existsSync(at)) {
        const r = relative(realTop, realpathSync.native(at)).split(sep).join('/');
        if (r && !/^\.\.(\/|$)/.test(r) && !isAbsolute(r) && !r.split('/').includes('node_modules')) out.push(r);
        break;
      }
      if (!d) break;
    }
  }
  return out;
}

/**
 * What a new worktree of `top` at `dir` lacks to build like the checkout: submodules' files, the
 * installed node_modules the project can reach, the ignored .env files, and the ignored files (dist/)
 * of workspace packages the project at `rel` depends on, copied so a build that writes there can't
 * reach the checkout.
 */
export async function fillWorktree(top: string, dir: string, rel: string) {
  const root = rel ? join(top, rel) : top, wroot = rel ? join(dir, rel) : dir;
  const realTop = realpathSync.native(top);
  // The project and the workspace packages it depends on, transitively.
  const pkgs = new Set([rel]);
  for (const queue = [rel]; queue.length;) for (const pkg of workspaceDeps(top, realTop, queue.shift()!)) if (!pkgs.has(pkg)) { pkgs.add(pkg); queue.push(pkg); }
  // node_modules a build of the project resolves from: its folders' above it (hoisted), its own and
  // those inside it, and those of the packages it depends on. Other installs in the repository
  // (unrelated apps, fixtures) stay out: linking them costs time and gains nothing.
  const reach = (d: string) => !d || rel === d || rel.startsWith(d + '/') || [...pkgs].some((p) => !p || d === p || d.startsWith(p + '/'));
  const ignored = await fillRepo(top, dir, { from: realTop, to: dir }, reach);
  for (const [from, to] of [[top, dir], [root, wroot]] as const) for (const n of envFiles(from)) if (!existsSync(join(to, n))) cpSync(join(from, n), join(to, n));
  for (const pkg of pkgs) {
    if (pkg === rel) continue;
    for (const p of ignored) {
      if (!p.startsWith(pkg + '/') || /(^|\/)node_modules\/$/.test(p)) continue;
      cpSync(join(top, p), join(dir, p), { recursive: true, verbatimSymlinks: true, force: false, filter: (src) => basename(src) !== 'node_modules' && !CACHES.has(basename(src)) });
    }
  }
}

/** A copy of the project as it is on disk, to build in. */
export async function isolatedCopy(root: string, log: (m: string) => void): Promise<Copy> {
  const g = await gitTop(root);
  const dir = scratch(root, 'build-');
  // A worktree has none of a project its repository ignores (one inside a dotfiles repo, an ignored playground/).
  if (!g || (g.rel && await git(g.top, ['check-ignore', '-q', '--', g.rel]).then(() => true, () => false))) {
    const wroot = join(dir, 'project');
    plainCopy(root, wroot);
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
    await fillWorktree(top, dir, rel);
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
