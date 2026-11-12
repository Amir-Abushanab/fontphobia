import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const runtime = fileURLToPath(new URL('../src/check-runtime.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-check-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (files: Record<string, string> = {}) => {
  const d = join(tmp, `p${n++}`);
  mkdirSync(d);
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t); }
  return d;
};
const run = (...a: string[]) => { const r = spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const integration = (root: string) => { const r = spawnSync(process.execPath, [runtime, JSON.stringify({ root, o: {} })], { encoding: 'utf8' }); return { code: r.status, out: r.stdout }; };

// A manifest whose source font is gone: check fails with an error, no browser or build needed.
const STALE = JSON.stringify({ version: 1, fontphobia: '0.0.0', harfbuzz: 'x', chrome: 'x', entries: { gone: {
  id: 'gone', adapter: 'css', family: 'Gone', stylesheet: 'gone.css', declaration: '@font-face{font-family:Gone;src:url(gone.ttf)}',
  source: { file: 'fonts/gone.ttf', sha256: '0'.repeat(64), bytes: 1 }, outputs: [], plan: { features: [], axes: {}, descriptors: {}, hinting: true, optIns: [] },
} } });
const NOTHING = 'fontphobia: nothing to check: no .fontphobia/manifest.json here (run fontphobia to build the subsets)';

describe('check CLI', () => {
  it('fails for a --cwd that is not a directory, for every command', () => {
    for (const cmd of ['check', 'audit', 'build', 'verify', 'revert', 'apply-kit']) {
      const r = run(cmd, '--cwd', join(tmp, 'missing'));
      expect(r.code, cmd).not.toBe(0);
      expect(r.err, cmd).toContain(`${join(tmp, 'missing')} is not a directory`);
    }
  });
  it('fails for a --cwd that is a file', () => {
    const d = dir({ f: 'x' });
    expect(run('check', '--cwd', join(d, 'f')).err).toContain('is not a directory');
  });
  it('with nothing to check, says so and exits 1 by default', () => {
    const r = run('check', '--cwd', dir());
    expect(r.out.trim()).toBe(NOTHING);
    expect(r.code).toBe(1);
  });
  it('exits 0 with --mode warn, and with check.mode warn in the config', () => {
    expect(run('check', '--mode', 'warn', '--cwd', dir()).code).toBe(0);
    const r = run('check', '--cwd', dir({ 'fontphobia.config.json': '{"check":{"mode":"warn"}}' }));
    expect(r.out.trim()).toBe(NOTHING);
    expect(r.code).toBe(0);
  });
  it('--json carries noManifest', () => { expect(JSON.parse(run('check', '--json', '--mode', 'warn', '--cwd', dir()).out).noManifest).toBe(true); });
});

describe('check-runtime as the integrations run it', () => {
  it('reads a config that imports defineConfig: a broken one is an error', () => {
    const r = integration(dir({ 'fontphobia.config.mjs': `import { defineConfig } from 'fontphobia'\nexport default defineConfig({ coreThreshhold: 1 })` }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^error\nfontphobia\.config\.mjs: unknown key "coreThreshhold"/);
  });
  it('a valid defineConfig config loads and check.mode warn is honored', () => {
    const files = { '.fontphobia/manifest.json': STALE };
    const fail = integration(dir(files));
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('fonts/gone.ttf');
    const r = integration(dir({ ...files, 'fontphobia.config.ts': `import { defineConfig } from 'fontphobia'\nexport default defineConfig({ check: { mode: 'warn' } })` }));
    expect(r.out).toMatch(/^warn\n/);
    expect(r.out).toContain('fonts/gone.ttf');
    expect(r.code).toBe(0);
  });
  it('with no manifest it logs at warn level and does not fail', () => {
    const r = integration(dir());
    expect(r.out).toBe(`warn\n${NOTHING}\n`);
    expect(r.code).toBe(0);
  });
});
