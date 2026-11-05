// Builds run in a throwaway copy of the working tree: a build that writes into tracked files (as
// sites that fetch data at build time do) leaves the project untouched, and the copy has every
// uncommitted change, untracked file and .env file, so it builds what's on disk.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProject, LEGACY_MANIFEST_FILE, MANIFEST_FILE, readManifest, revertProject, writeManifest } from '@fontphobia/core';
import { isolatedCopy } from '../src/isolate.ts';
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
  return root;
}

describe('isolated builds', () => {
  it('copies the working tree as it is on disk, and removes the worktree afterwards', async () => {
    const root = repo();
    const copy = await isolatedCopy(root, detectProject, () => {});
    expect(readFileSync(join(copy.root, 'page.txt'), 'utf8')).toBe('uncommitted');
    expect(readFileSync(join(copy.root, 'new.txt'), 'utf8')).toBe('untracked');
    expect(existsSync(join(copy.root, 'gone.txt'))).toBe(false);
    expect(readFileSync(join(copy.root, '.env'), 'utf8')).toBe('SECRET=1');
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
