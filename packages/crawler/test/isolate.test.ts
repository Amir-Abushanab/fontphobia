// Builds run in a throwaway copy of the working tree: a build that writes into tracked files (as
// sites that fetch data at build time do) leaves the project untouched, and the copy has every
// uncommitted change, untracked file and .env file, so it builds what's on disk.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProject, LEGACY_MANIFEST_FILE, MANIFEST_FILE, readManifest, revertProject, writeManifest } from '@fontphobia/core';
import { isolatedCopy } from '../src/isolate.ts';
import { runCommand } from '../src/server.ts';
import { openSite } from '../src/site.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-isolate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

// A static site whose build writes dist/ and also rewrites a tracked data file.
const BUILD = `node -e "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('data.json','{\\"fetched\\":true}');fs.writeFileSync('dist/index.html','<p>'+fs.readFileSync('page.txt','utf8')+' '+(fs.existsSync('.env')?'env':'no env')+'</p>')"`;

function repo(): string {
  const root = mkdtempSync(join(tmp, 'site-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { build: BUILD } }));
  writeFileSync(join(root, 'data.json'), '{"fetched":false}');
  writeFileSync(join(root, 'page.txt'), 'committed');
  writeFileSync(join(root, 'gone.txt'), 'deleted in the working tree');
  writeFileSync(join(root, '.gitignore'), 'dist\n.env\nnode_modules\n');
  sh(root, 'init', '-q');
  sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  // The working tree: a modified file, an untracked one, a deleted one, and an ignored .env.
  writeFileSync(join(root, 'page.txt'), 'uncommitted');
  writeFileSync(join(root, 'new.txt'), 'untracked');
  rmSync(join(root, 'gone.txt'));
  writeFileSync(join(root, '.env'), 'SECRET=1');
  // An installed package, and a link to it the way pnpm lays them out.
  mkdirSync(join(root, 'node_modules/.pnpm/dep/node_modules/dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.pnpm/dep/node_modules/dep/index.astro'), '<p>dep</p>');
  symlinkSync('.pnpm/dep/node_modules/dep', join(root, 'node_modules/dep'), 'junction');
  symlinkSync(join(root, 'node_modules/.pnpm/dep/node_modules/dep'), join(root, 'node_modules/alias'), 'junction'); // absolute, as Windows junctions are
  return root;
}

describe('isolated builds', () => {
  it('copies the working tree as it is on disk, and removes the worktree afterwards', async () => {
    const root = repo();
    const copy = await isolatedCopy(root, () => {});
    expect(readFileSync(join(copy.root, 'page.txt'), 'utf8')).toBe('uncommitted');
    expect(readFileSync(join(copy.root, 'new.txt'), 'utf8')).toBe('untracked');
    expect(existsSync(join(copy.root, 'gone.txt'))).toBe(false);
    expect(readFileSync(join(copy.root, '.env'), 'utf8')).toBe('SECRET=1');
    // Dependencies: hard-linked, so their real paths stay in the copy (Astro compiles .astro files from packages).
    expect(realpathSync(join(copy.root, 'node_modules/dep/index.astro')).startsWith(realpathSync(copy.root))).toBe(true);
    expect(realpathSync(join(copy.root, 'node_modules/alias/index.astro')).startsWith(realpathSync(copy.root))).toBe(true);
    expect(copy.root.startsWith(join(root, '.fontphobia', 'tmp'))).toBe(true);
    await copy.remove();
    expect(existsSync(copy.root)).toBe(false);
    expect(sh(root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('builds in the copy: the project keeps its files, the served site is the working tree', async () => {
    const root = repo();
    const status = sh(root, 'status', '--porcelain');
    const site = await openSite({ rebuild: true, buildCmd: BUILD }, detectProject(root), () => {});
    try {
      expect(await (await fetch(site.base)).text()).toBe('<p>uncommitted env</p>');
      expect(site.root).not.toBe(root);
    } finally { await site.stop(); }
    expect(readFileSync(join(root, 'data.json'), 'utf8')).toBe('{"fetched":false}');
    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(sh(root, 'status', '--porcelain')).toBe(status);
    expect(existsSync(site.root)).toBe(false);
  });

  it('builds in a plain copy outside git', async () => {
    const root = mkdtempSync(join(tmp, 'nogit-'));
    writeFileSync(join(root, 'data.json'), '{"fetched":false}');
    writeFileSync(join(root, 'page.txt'), 'plain');
    const site = await openSite({ rebuild: true, buildCmd: BUILD }, detectProject(root), () => {});
    try { expect(await (await fetch(site.base)).text()).toBe('<p>plain no env</p>'); } finally { await site.stop(); }
    expect(readFileSync(join(root, 'data.json'), 'utf8')).toBe('{"fetched":false}');
  });
});

describe('what a copy needs besides the working tree', () => {
  const git = (cwd: string, ...args: string[]) => sh(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args);
  const w = (f: string, t: string) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, t); };

  it("links every workspace package's node_modules, and copies the ignored output of the packages the project uses", async () => {
    // A pnpm workspace as `pnpm install` and a build of packages/ui leave it.
    const top = mkdtempSync(join(tmp, 'workspace-'));
    w(join(top, 'pnpm-workspace.yaml'), 'packages: [apps/*, packages/*]\n');
    w(join(top, '.gitignore'), 'node_modules\ndist\n');
    w(join(top, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { '@acme/ui': 'workspace:*' } }));
    w(join(top, 'packages/ui/package.json'), JSON.stringify({ name: '@acme/ui', main: 'dist/index.js', dependencies: { clsx: '2' } }));
    git(top, 'init', '-q'); git(top, 'add', '-A'); git(top, 'commit', '-qm', 'init');
    w(join(top, 'packages/ui/dist/index.js'), "module.exports = 'ui ' + require('clsx');\n");
    w(join(top, 'node_modules/.pnpm/clsx@2/node_modules/clsx/index.js'), "module.exports = 'clsx';\n");
    w(join(top, 'node_modules/.pnpm/clsx@2/node_modules/clsx/package.json'), '{"name":"clsx","main":"index.js"}');
    mkdirSync(join(top, 'packages/ui/node_modules'), { recursive: true });
    symlinkSync('../../../node_modules/.pnpm/clsx@2/node_modules/clsx', join(top, 'packages/ui/node_modules/clsx'), 'junction');
    mkdirSync(join(top, 'apps/web/node_modules/@acme'), { recursive: true });
    symlinkSync('../../../../packages/ui', join(top, 'apps/web/node_modules/@acme/ui'), 'junction');
    const copy = await isolatedCopy(join(top, 'apps/web'), () => {});
    try {
      // The build reads the sibling's output and its dependency, and writes into that output.
      const r = await runCommand(`node -e "const fs=require('fs');console.log(require('@acme/ui'));fs.writeFileSync(require.resolve('@acme/ui'),'changed')"`, copy.root);
      expect(r).toEqual({ code: 0, output: 'ui clsx\n' });
      expect(readFileSync(join(top, 'packages/ui/dist/index.js'), 'utf8')).toMatch(/^module\.exports/);
    } finally { await copy.remove(); }
  });

  it('fills submodules with their files', async () => {
    const theme = mkdtempSync(join(tmp, 'theme-'));
    w(join(theme, 'layouts/index.html'), '<h1>theme</h1>');
    git(theme, 'init', '-q'); git(theme, 'add', '-A'); git(theme, 'commit', '-qm', 'theme');
    const top = mkdtempSync(join(tmp, 'hugo-'));
    w(join(top, 'hugo.toml'), 'theme = "t"\n');
    git(top, 'init', '-q'); git(top, 'submodule', 'add', '-q', theme, 'themes/t'); git(top, 'commit', '-qm', 'init');
    const copy = await isolatedCopy(top, () => {});
    try {
      expect(readFileSync(join(copy.root, 'themes/t/layouts/index.html'), 'utf8')).toBe('<h1>theme</h1>');
      expect(existsSync(join(copy.root, 'themes/t/.git'))).toBe(false);
    } finally { await copy.remove(); }
  });

  it('copies a project its repository ignores', async () => {
    const top = mkdtempSync(join(tmp, 'dotfiles-'));
    w(join(top, '.gitignore'), '/playground/\n');
    git(top, 'init', '-q'); git(top, 'add', '-A'); git(top, 'commit', '-qm', 'init');
    const root = join(top, 'playground/site');
    w(join(root, 'index.html'), '<p>hi</p>');
    w(join(root, '.next/cache/x'), 'cache');
    w(join(root, 'node_modules/dep/index.js'), "module.exports = 'dep';\n");
    const copy = await isolatedCopy(root, () => {});
    try {
      expect(readFileSync(join(copy.root, 'index.html'), 'utf8')).toBe('<p>hi</p>');
      expect(existsSync(join(copy.root, '.next'))).toBe(false);
      expect(realpathSync(join(copy.root, 'node_modules/dep/index.js')).startsWith(realpathSync(copy.root))).toBe(true);
    } finally { await copy.remove(); }
  });

  it("fails like a command when it can't start (no such folder)", async () => {
    const r = await runCommand('echo hi', join(tmp, 'missing'));
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/ENOENT/);
  });
});

describe('.fontphobia/', () => {
  const m = { version: 1, fontphobia: '1', harfbuzz: '1', chrome: '1', entries: {} };
  it('reads a 0.1.x manifest from the project root and moves it into .fontphobia/ on the next write', () => {
    const root = mkdtempSync(join(tmp, 'legacy-'));
    writeFileSync(join(root, LEGACY_MANIFEST_FILE), JSON.stringify(m));
    expect(readManifest(root)).toEqual(m);
    writeManifest(root, m);
    expect(existsSync(join(root, LEGACY_MANIFEST_FILE))).toBe(false);
    expect(readManifest(root)).toEqual(m);
    expect(existsSync(join(root, MANIFEST_FILE))).toBe(true);
  });

  it('ignores everything in .fontphobia/ but the manifest and sources/', () => {
    const root = mkdtempSync(join(tmp, 'ignore-'));
    sh(root, 'init', '-q');
    writeManifest(root, m);
    for (const f of ['usage.json', 'report.md', 'cache/visits/a', 'verify/d.png', 'sources/google/a.woff2']) {
      mkdirSync(join(root, '.fontphobia', f, '..'), { recursive: true });
      writeFileSync(join(root, '.fontphobia', f), 'x');
    }
    expect(sh(root, 'status', '--porcelain', '--untracked-files=all').trim().split('\n').sort()).toEqual(['?? .fontphobia/manifest.json', '?? .fontphobia/sources/google/a.woff2']);
  });

  it('revert removes .fontphobia/ when nothing but its .gitignore is left', () => {
    const root = mkdtempSync(join(tmp, 'revert-'));
    writeManifest(root, m);
    revertProject(root, { write: true });
    expect(existsSync(join(root, '.fontphobia'))).toBe(false);
  });
});
