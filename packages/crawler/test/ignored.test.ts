// Everything fontphobia writes under .fontphobia/ is gitignored from its first write: a run that is
// interrupted mid-crawl, or one whose reports go elsewhere (--out-dir), leaves nothing for
// `git add -A` to pick up but the manifest and sources/.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureIgnoredFor } from '@fontphobia/core';
import { launchChrome, VisitCache } from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repo, 'packages/cli/src/cli.ts');
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-ignored-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let chrome = true;
try {
  await (await launchChrome()).close();
} catch (e) {
  if (process.env.CI) throw e;
  chrome = false;
}

let n = 0;
/** A git repository with one commit, so `git status` shows only what a run adds. */
function gitRepo(from?: string): string {
  const d = join(tmp, `r${n++}`);
  if (from) cpSync(from, d, { recursive: true });
  else mkdirSync(d);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (from) {
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'site');
  }
  return d;
}
const status = (d: string) =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: d, encoding: 'utf8' });

describe('.fontphobia is ignored from its first write', () => {
  it('the page-load cache creates the .gitignore before its first entry', () => {
    const d = gitRepo();
    const cache = new VisitCache(d, { chrome: 'x', fontphobia: 'x', userAgent: 'x', locales: [] });
    const key = cache.keyOf('http://localhost/', { viewport: 1280, fontSize: 16 });
    cache.put(key, 'http://localhost', {
      visit: { page: '/' } as never,
      resources: [],
      status: 200,
      finalUrl: 'http://localhost/',
      links: [],
      bodies: new Map(),
    });
    expect(readdirSync(join(d, '.fontphobia/cache/visits'))).toEqual([`${key}.json`]);
    expect(status(d)).toBe('');
  });

  it('a path under .fontphobia/ (verify diff images) gets the folder and its .gitignore; other paths nothing', () => {
    const d = gitRepo();
    ensureIgnoredFor(join(d, '.fontphobia', 'verify'));
    expect(existsSync(join(d, '.fontphobia', '.gitignore'))).toBe(true);
    const other = gitRepo();
    ensureIgnoredFor(join(other, 'reports', 'verify'));
    expect(existsSync(join(other, '.fontphobia'))).toBe(false);
  });

  it.skipIf(!chrome)(
    'an audit killed after its first page load leaves git status clean',
    async () => {
      const site = gitRepo(join(repo, 'fixtures/sites/static-css'));
      cpSync(join(repo, 'fixtures/fonts/InterVariable.ttf'), join(site, 'fonts', 'InterVariable.ttf'), {
        recursive: true,
      });
      execFileSync('git', ['add', '-A'], { cwd: site });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'font'], { cwd: site });
      const visits = join(site, '.fontphobia/cache/visits');
      const child = spawn(process.execPath, [cli, 'audit', '--dist', '.', '--ci', '--cwd', site], { stdio: 'ignore' });
      const exited = new Promise((r) => child.once('exit', r));
      const deadline = Date.now() + 60_000;
      while (!(existsSync(visits) && readdirSync(visits).length) && child.exitCode === null && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 25));
      child.kill('SIGKILL');
      await exited;
      expect(readdirSync(visits).length).toBeGreaterThan(0);
      expect(existsSync(join(site, '.fontphobia', 'usage.json'))).toBe(false); // it never got that far
      expect(status(site)).toBe('');
    },
    90_000,
  );

  it.skipIf(!chrome)(
    'with --out-dir, the cache under .fontphobia/ is still ignored',
    () => {
      const site = gitRepo(join(repo, 'fixtures/sites/static-css'));
      execFileSync(process.execPath, [cli, 'audit', '--dist', '.', '--ci', '--out-dir', 'reports', '--cwd', site], {
        stdio: 'pipe',
      });
      expect(readdirSync(join(site, '.fontphobia/cache/visits')).length).toBeGreaterThan(0);
      expect(
        status(site)
          .split('\n')
          .filter((l) => l && !l.includes(' reports/')),
      ).toEqual([]);
    },
    120_000,
  );
});
