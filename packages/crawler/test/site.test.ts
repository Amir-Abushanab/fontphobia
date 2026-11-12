// --dist says where the build output is, not "never build": with a build command it's built (in a
// copy) when missing, when stale and the caller agrees, or with --rebuild; without one it's served as it is.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectProject, KEPT_OUTPUT } from '@fontphobia/core';
import { openSite, type SiteOptions } from '../src/site.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-site-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const BUILD = `node -e "const fs=require('fs');fs.mkdirSync('www',{recursive:true});fs.writeFileSync('www/index.html','<p>'+fs.readFileSync('page.txt','utf8')+'</p>')"`;

/** A project whose source is page.txt; `built` leaves www/ from an earlier build, older than the source. */
function project(o: { built?: boolean; script?: boolean } = {}): string {
  const root = mkdtempSync(join(tmp, 'p-'));
  if (o.script) writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { build: BUILD } }));
  writeFileSync(join(root, 'page.txt'), 'old');
  if (o.built) {
    mkdirSync(join(root, 'www'));
    writeFileSync(join(root, 'www/index.html'), '<p>old</p>');
    const t = Date.now() / 1000 - 3600;
    utimesSync(join(root, 'www/index.html'), t, t);
    writeFileSync(join(root, 'page.txt'), 'new');
  }
  return root;
}

async function served(root: string, o: SiteOptions, logs: string[] = []) {
  const site = await openSite(o, detectProject(root), (m) => logs.push(m));
  try { return { text: await (await fetch(site.base)).text(), built: site.built, site }; } finally { await site.stop(); }
}

describe('--dist with a build command', () => {
  it('builds a missing output in a copy and serves it from there', async () => {
    const root = project();
    const r = await served(root, { dist: 'www', buildCmd: BUILD });
    expect(r.text).toBe('<p>old</p>');
    expect(r.built).toBe(BUILD);
    expect(r.site.root).not.toBe(root);
    expect(existsSync(join(root, 'www'))).toBe(false);
  });

  it('asks about a stale output and rebuilds when the caller agrees', async () => {
    const root = project({ built: true });
    let asked = 0;
    const r = await served(root, { dist: 'www', buildCmd: BUILD, onStale: () => { asked++; return true; } });
    expect(asked).toBe(1);
    expect(r.text).toBe('<p>new</p>');
    expect(r.built).toBe(BUILD);
    expect(readFileSync(join(root, 'www/index.html'), 'utf8')).toBe('<p>old</p>');
  });

  it('serves the stale output when the caller declines, and rebuilds without asking with --rebuild', async () => {
    const root = project({ built: true });
    const logs: string[] = [];
    const kept = await served(root, { dist: 'www', buildCmd: BUILD, onStale: () => false }, logs);
    expect(kept.text).toBe('<p>old</p>');
    expect(kept.built).toBeUndefined();
    expect(logs.join('\n')).toMatch(/page\.txt changed after www was built/);
    const rebuilt = await served(root, { dist: 'www', buildCmd: BUILD, rebuild: true, onStale: () => { throw new Error('asked'); } });
    expect(rebuilt.text).toBe('<p>new</p>');
  });

  it("uses the project's build script when there's no --build-cmd", async () => {
    const root = project({ script: true });
    const r = await served(root, { dist: 'www' });
    expect(r.text).toBe('<p>old</p>');
    expect(r.built).toBe('npm run build');
  });

  it('keeps the output it built, and serves that while nothing changed', async () => {
    const root = project();
    const site = await openSite({ dist: 'www', buildCmd: BUILD }, detectProject(root), () => {});
    site.keepOutput!();
    await site.stop();
    expect(readFileSync(join(root, KEPT_OUTPUT, 'www/index.html'), 'utf8')).toBe('<p>old</p>');
    const logs: string[] = [];
    const again = await served(root, { dist: 'www', buildCmd: BUILD, onStale: () => { throw new Error('asked'); } }, logs);
    expect(again.built).toBeUndefined();
    expect(again.site.site?.dir).toBe(join(root, KEPT_OUTPUT, 'www'));
    expect(again.text).toBe('<p>old</p>');
  });
});

describe('--dist without a build command', () => {
  it('serves the output as it is, with a warning when it is stale', async () => {
    const root = project({ built: true });
    const logs: string[] = [];
    let asked = false;
    const r = await served(root, { dist: 'www', rebuild: true, onStale: () => { asked = true; return true; } }, logs);
    expect(r.text).toBe('<p>old</p>');
    expect(r.built).toBeUndefined();
    expect(asked).toBe(false);
    expect(logs.join('\n')).toMatch(/warning: page\.txt changed after www was built/);
  });

  it('says so when the output is missing', async () => {
    await expect(openSite({ dist: 'www' }, detectProject(project()), () => {})).rejects.toThrow(/www \(--dist\) is not a directory, and there is no build command/);
  });
});
