// M6: `fontphobia/vite` keeps fontphobia's files out of asset inlining (§13), in a real Vite build.
// Uses the Vite installed in the TanStack Start fixture (`pnpm install` there; the sites CI job does).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { devWarningScript, fontphobia, isOutputFile } from '../src/vite.ts';

const vitePath = fileURLToPath(new URL('../../../fixtures/sites/tanstack-start/node_modules/vite/dist/node/index.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-vite-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fontphobia/vite', () => {
  it('recognizes output files by the manifest or by name', () => {
    expect(isOutputFile('/x/fonts/Inter.ext.0123abcd.woff2')).toBe(true);
    expect(isOutputFile('/x/fonts/Inter.woff2')).toBe(false);
    expect(isOutputFile('/x/fonts/custom.woff2?v=1', { entries: { a: { family: 'A', outputs: [{ role: 'ext', file: 'fonts/custom.woff2', unicodeRange: 'U+41' }] } } })).toBe(true);
  });

  it('builds a dev warning script from the manifest (core and extended ranges only)', () => {
    const root = join(tmp, 'dev');
    mkdirSync(root);
    writeFileSync(join(root, 'fontphobia.manifest.json'), JSON.stringify({ entries: { a: { family: 'Inter', outputs: [
      { role: 'core', file: 'a.core.11111111.woff2', unicodeRange: 'U+20-7E' }, { role: 'ext', file: 'a.ext.22222222.woff2', unicodeRange: 'U+A0-FF' }, { role: 'rest', file: 'a.rest.33333333.woff2', unicodeRange: 'U+100-17F' },
    ] } } }));
    const s = devWarningScript(root)!;
    expect(s).toContain('{"inter":[[32,126],[160,255]]}');
    expect(() => new Function(s)).not.toThrow();
    expect(devWarningScript(join(tmp, 'none'))).toBeUndefined();
  });

  it.skipIf(!existsSync(vitePath))('keeps a small fontphobia file as a file while other small fonts inline as before', async () => {
    const root = join(tmp, 'site');
    mkdirSync(join(root, 'fonts'), { recursive: true });
    writeFileSync(join(root, 'fonts/small.woff2'), Buffer.alloc(900, 1));
    writeFileSync(join(root, 'fonts/Inter.ext.0123abcd.woff2'), Buffer.alloc(900, 2));
    writeFileSync(join(root, 'style.css'), "@font-face{font-family:A;src:url('./fonts/small.woff2') format('woff2')}\n@font-face{font-family:B;src:url('./fonts/Inter.ext.0123abcd.woff2') format('woff2')}\nbody{font-family:A,B}\n");
    writeFileSync(join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="./style.css"><p>hi</p>');
    const vite = (await import(pathToFileURL(vitePath).href)) as { build: (c: unknown) => Promise<unknown> };
    await vite.build({ root, logLevel: 'silent', configFile: false, plugins: [fontphobia({ root })], build: { outDir: join(root, 'dist') } });
    const assets = readdirSync(join(root, 'dist/assets'));
    const css = readFileSync(join(root, 'dist/assets', assets.find((f) => f.endsWith('.css'))!), 'utf8');
    expect(css).toMatch(/src:url\(data:font\/woff2;base64,/); // small.woff2: inlined, as Vite does by default
    expect(assets.some((f) => /^Inter\.ext\.0123abcd-.*\.woff2$/.test(f))).toBe(true); // ours: a file
    expect(css).toMatch(/url\(\/assets\/Inter\.ext\.0123abcd-[\w-]+\.woff2\)/);
  }, 120_000);
});
