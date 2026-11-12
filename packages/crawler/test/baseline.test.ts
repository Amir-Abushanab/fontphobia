// The worktree baseline (§10.3): HEAD built in a git worktree that gets what the build in a copy
// gets (dependencies, .env files, submodules), accepting every file fontphobia's build changed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Manifest } from '@fontphobia/core';
import { worktreeBaseline } from '../src/baseline.ts';
import type { SiteOptions } from '../src/site.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-baseline-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString();
const w = (f: string, t: string) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, t); };
const empty: Manifest = { version: 1, fontphobia: '0', harfbuzz: '0', chrome: '0', entries: {} };

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmp, 'repo-'));
  for (const [f, t] of Object.entries(files)) w(join(root, f), t);
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  return root;
}

async function before(root: string, m: Manifest, o: SiteOptions = {}): Promise<string> {
  const b = await worktreeBaseline(root, m, o, () => {});
  try { return await (await fetch(b.site.base)).text(); } finally { await b.stop(); }
}

describe('worktree baseline', () => {
  it("gets the checkout's .env files, as the build in a copy does", async () => {
    const BUILD = `node -e "const fs=require('fs');if(!fs.existsSync('.env'))process.exit(1);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>'+fs.readFileSync('.env','utf8')+'</h1>')"`;
    const root = repo({ 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { build: BUILD } }), '.gitignore': 'dist\n.env\n' });
    writeFileSync(join(root, '.env'), 'TITLE=Hello');
    expect(await before(root, empty)).toBe('<h1>TITLE=Hello</h1>');
  });

  it('builds HEAD into --dist when there is a build command', async () => {
    const BUILD = `node -e "const fs=require('fs');fs.mkdirSync('www',{recursive:true});fs.writeFileSync('www/index.html','<p>'+fs.readFileSync('page.txt','utf8')+'</p>')"`;
    const root = repo({ 'page.txt': 'head', '.gitignore': 'www\n' });
    expect(await before(root, empty, { dist: 'www', buildCmd: BUILD })).toBe('<p>head</p>');
  });

  it('accepts the document.fonts calls fontphobia rewrote as its own changes', async () => {
    const root = repo({
      'index.html': '<link rel=stylesheet href=styles.css><p>hi</p>',
      'styles.css': '@font-face{font-family:X;src:url(x.woff2)}',
      'src/main.js': "await document.fonts.load('16px X');\n",
    });
    const to = "document.fonts.load('16px X', document.body.innerText)";
    writeFileSync(join(root, 'src/main.js'), `await ${to};\n`);
    const m: Manifest = { ...empty, fontChecks: [{ file: 'src/main.js', from: "document.fonts.load('16px X')", to }] };
    w(join(root, '.fontphobia/manifest.json'), JSON.stringify(m));
    expect(await before(root, m, { dist: '.' })).toMatch(/<p>hi<\/p>/);
  });
});
