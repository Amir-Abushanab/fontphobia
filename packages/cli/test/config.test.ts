import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, selfUrl } from '../src/config.ts';

const configTs = fileURLToPath(new URL('../src/config.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function proj(file: string, text: string): string {
  const d = join(tmp, `p${n++}`);
  mkdirSync(d);
  writeFileSync(join(d, file), text);
  return d;
}
const load = (d: string) => loadConfig(d, selfUrl(pathToFileURL(configTs).href));
const json = (c: unknown) => proj('fontphobia.config.json', JSON.stringify(c));
const bad = (c: unknown, msg: string | RegExp) =>
  it(`rejects ${JSON.stringify(c).slice(0, 60)}`, async () => {
    await expect(load(json(c))).rejects.toThrow(msg);
  });

// The resolve hook is registered once per process, so configs that import 'fontphobia' load in a child.
function loadInChild(d: string): { config: unknown; file?: string } | { error: string } {
  const script = join(tmp, `child${n++}.ts`);
  const self = JSON.stringify(pathToFileURL(configTs).href);
  writeFileSync(
    script,
    `import { loadConfig, selfUrl } from ${self};
try { process.stdout.write(JSON.stringify(await loadConfig(process.argv[2]!, selfUrl(${self})))); } catch (e) { process.stdout.write(JSON.stringify({ error: (e as Error).message })); }`,
  );
  return JSON.parse(execFileSync(process.execPath, [script, d], { encoding: 'utf8' }));
}

describe('loadConfig formats', () => {
  it('returns {} without a config', async () => {
    expect(await load(proj('x.txt', ''))).toEqual({ config: {} });
  });
  it('reads .json', async () => {
    expect(await load(json({ dist: 'out', check: { mode: 'warn' } }))).toEqual({
      config: { dist: 'out', check: { mode: 'warn' } },
      file: 'fontphobia.config.json',
    });
  });
  it('reads .mjs', async () => {
    expect((await load(proj('fontphobia.config.mjs', 'export default { dist: "x" }'))).config).toEqual({ dist: 'x' });
  });
  it('reads .ts', async () => {
    expect(
      (await load(proj('fontphobia.config.ts', 'const c: { dist: string } = { dist: "t" }; export default c'))).config,
    ).toEqual({ dist: 't' });
  });
  for (const f of ['fontphobia.config.ts', 'fontphobia.config.mjs']) {
    it(`${f} importing defineConfig from 'fontphobia' loads with the self URL`, () => {
      const r = loadInChild(
        proj(
          f,
          `import { defineConfig } from 'fontphobia'\nexport default defineConfig({ dist: 'd', check: { mode: 'warn' } })`,
        ),
      );
      expect(r).toEqual({ config: { dist: 'd', check: { mode: 'warn' } }, file: f });
    });
  }
  it('validates module configs too', () => {
    const r = loadInChild(proj('fontphobia.config.mjs', 'export default { coreThreshhold: 1 }'));
    expect(r).toEqual({ error: 'fontphobia.config.mjs: unknown key "coreThreshhold"; did you mean "coreThreshold"?' });
  });
  it('names the file on malformed JSON', async () => {
    await expect(load(proj('fontphobia.config.json', '{ nope'))).rejects.toThrow(/^fontphobia\.config\.json: /);
  });
});

describe('loadConfig validation', () => {
  it('accepts the README example', async () => {
    const c = {
      dist: 'dist',
      build: 'pnpm build',
      start: 'node server.js',
      pages: ['/', '/blog/**'],
      ignore: ['/admin/**'],
      auth: { storageState: '.auth.json' },
      viewports: [360, 768, 1280, 1920],
      locales: ['en', 'fr'],
      maxPages: 500,
      coreThreshold: 'auto',
      remainder: true,
      allow: [],
      rename: { 'Source Serif 4': 'SrcSerif Subset' },
      licenses: { allow: [] },
      check: { mode: 'error', strict: false, allowChars: '' },
      verify: { browsers: ['chromium'], hinting: false, viewports: [360, 1280], dprs: [1, 2] },
    };
    expect((await load(json(c))).config).toEqual(c);
  });
  it('accepts a share of pages for coreThreshold', async () => {
    for (const coreThreshold of [0, 0.5, 1])
      expect((await load(json({ coreThreshold }))).config).toEqual({ coreThreshold });
  });
  it('accepts inlineCoreMax as a number or as block and swap allowances', async () => {
    for (const inlineCoreMax of [0, 65536, { block: 98304 }, { block: 98304, swap: 16384 }])
      expect((await load(json({ inlineCoreMax }))).config).toEqual({ inlineCoreMax });
  });
  bad({ inlineCoreMax: '16k' }, '"inlineCoreMax" must be a number of bytes, or { block, swap } with numbers of bytes');
  bad(
    { inlineCoreMax: { swp: 1 } },
    '"inlineCoreMax" must be a number of bytes, or { block, swap } with numbers of bytes',
  );
  bad({ ignore: '/admin/**' }, 'fontphobia.config.json: "ignore" must be an array of strings');
  bad({ coreThreshhold: 0.5 }, 'fontphobia.config.json: unknown key "coreThreshhold"; did you mean "coreThreshold"?');
  bad({ banana: 1 }, 'fontphobia.config.json: unknown key "banana"');
  bad({ auth: { storagState: 'x' } }, 'unknown key "auth.storagState"; did you mean "auth.storageState"?');
  bad({ licenses: { alow: [] } }, 'unknown key "licenses.alow"; did you mean "licenses.allow"?');
  bad({ check: { mod: 'warn' } }, 'unknown key "check.mod"; did you mean "check.mode"?');
  bad({ verify: { browser: [] } }, 'unknown key "verify.browser"; did you mean "verify.browsers"?');
  bad({ dist: 1 }, '"dist" must be a string');
  bad({ maxPages: '5' }, '"maxPages" must be a number');
  bad({ remainder: 'yes' }, '"remainder" must be a boolean');
  bad({ viewports: ['a'] }, '"viewports" must be an array of numbers');
  bad({ rename: { a: 1 } }, '"rename" must be an object of strings');
  bad({ auth: 'x' }, '"auth" must be an object');
  bad({ check: { strict: 1 } }, '"check.strict" must be a boolean');
  bad({ check: { mode: 'fail' } }, '"check.mode" must be one of');
  bad({ verify: { browsers: ['ie'] } }, '"verify.browsers" must be an array of');
  bad({ allow: ['nope'] }, '"allow" must be an array of');
  bad({ coreThreshold: 2 }, `"coreThreshold" must be 'auto' or a number between 0 and 1`);
  bad({ coreThreshold: -0.1 }, `"coreThreshold" must be 'auto' or a number between 0 and 1`);
  bad({ coreThreshold: 'half' }, `"coreThreshold" must be 'auto' or a number between 0 and 1`);
  bad({ auto: 'chrome' }, `"auto" must be true, false, 'static' or 'crawl'`);
  bad({ autoRules: 'file' }, '"autoRules" must be one of');
  bad([], 'must be an object');
});
