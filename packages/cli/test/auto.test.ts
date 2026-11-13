// `fontphobia auto` and the integrations' `auto` option, static mode (no browser).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { postBuildCheck } from '../src/integration.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-auto-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A project whose build output is `dist/`: one page, one stylesheet, one font. */
function project(name: string) {
  const root = join(tmp, name);
  mkdirSync(join(root, 'dist/fonts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"site","private":true}');
  writeFileSync(
    join(root, 'dist/styles.css'),
    '@font-face{font-family:Deja;src:url(fonts/DejaVuSans.ttf)}body{font-family:Deja}',
  );
  writeFileSync(
    join(root, 'dist/index.html'),
    '<!doctype html><html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body>Hello</body></html>',
  );
  for (const f of ['DejaVuSans.ttf', 'DejaVu-LICENSE.txt'])
    cpSync(join(fixtures, 'fonts', f), join(root, 'dist/fonts', f));
  return root;
}
/** Whether the page carries the split rules. */
const sheet = (root: string) =>
  readFileSync(join(root, 'dist/index.html'), 'utf8').includes('<style data-fontphobia>') || undefined;

test('auto --dry-run reports and writes nothing; auto writes into the output only', () => {
  const root = project('cli');
  const dry = execFileSync(process.execPath, [cli, 'auto', '--cwd', root, '--dist', 'dist', '--dry-run'], {
    encoding: 'utf8',
  });
  expect(dry).toMatch(/fontphobia auto \(static\): 1 face\(s\) subset in dist \(dry run: nothing written\)/);
  expect(sheet(root)).toBeUndefined();

  const r = JSON.parse(
    execFileSync(process.execPath, [cli, 'auto', '--cwd', root, '--dist', 'dist', '--json'], { encoding: 'utf8' }),
  );
  expect(r).toMatchObject({ mode: 'static', written: true, linked: 1, checked: { outputs: 3 } });
  expect(r.usage).toBeUndefined();
  expect(r.manifest).toBeUndefined();
  expect(r.inlined.bytes).toBeGreaterThan(0);
  expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).toMatch(
    /<style data-fontphobia>[\s\S]*<\/style><\/head>/,
  );
  // Nothing outside the output: no manifest, no .fontphobia directory.
  expect(readdirSync(root).toSorted()).toEqual(['dist', 'package.json']);

  const again = spawnSync(process.execPath, [cli, 'auto', '--cwd', root, '--dist', 'dist'], { encoding: 'utf8' });
  expect(again.status).toBe(1);
  expect(again.stderr).toMatch(/already subset by `fontphobia auto`; build the site again first/);
}, 120_000);

test('auto without a built site says what it needs', () => {
  const root = join(tmp, 'empty');
  mkdirSync(root);
  const r = spawnSync(process.execPath, [cli, 'auto', '--cwd', root], { encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/No built static output found/);
});

test("an integration's `auto` option subsets the output it is given, and fails the build on an error", async () => {
  const root = project('integration');
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`warn: ${m}`) };
  await postBuildCheck(root, join(root, 'dist'), { auto: true }, log);
  expect(logs.join('\n')).toMatch(/fontphobia auto \(static\): 1 face\(s\) subset in dist/);
  expect(sheet(root)).toBeDefined();
  await expect(postBuildCheck(root, join(root, 'dist'), { auto: true }, log)).rejects.toThrow(/already subset/);
}, 120_000);

test("the config's `auto` key does the same for an integration without the option (Next), and the option wins", async () => {
  const root = project('config-auto');
  writeFileSync(join(root, 'fontphobia.config.json'), '{"auto":true}');
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`warn: ${m}`) };
  await postBuildCheck(root, join(root, 'dist'), { auto: false }, log);
  expect(sheet(root)).toBeUndefined();
  await postBuildCheck(root, join(root, 'dist'), {}, log);
  expect(logs.join('\n')).toMatch(/fontphobia auto \(static\): 1 face\(s\) subset in dist/);
  expect(sheet(root)).toBeDefined();
}, 120_000);
