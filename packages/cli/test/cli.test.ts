import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const font = join(fixtures, 'fonts/InterVariable.ttf');
const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('inspect --json', () => {
  const info = JSON.parse(run('inspect', font, '--json'));
  expect(info.axes.map((a: { tag: string }) => a.tag)).toEqual(['opsz', 'wght']);
  expect(info.os2.fsType.embedding).toBe('installable');
});

test('subset writes a WOFF2 and prints its unicode-range', () => {
  const out = join(tmp, 'x.woff2');
  const stdout = run('subset', font, '--unicodes', 'U+20-7E', '--features', '+tnum', '-o', out);
  expect(stdout).toMatch(/unicode-range: U\+20-7E/);
  expect(String.fromCharCode(...readFileSync(out).subarray(0, 4))).toBe('wOF2');
});

test('numeric-looking option values stay strings', () => {
  const out = join(tmp, 'n.woff2');
  // --text 2024 keeps 2, 0, 4; --text 0 keeps only "0" (it used to keep every character)
  expect(run('subset', font, '--text', '2024', '-o', out)).toMatch(/3 characters/);
  expect(run('subset', font, '--text', '0', '-o', out)).toMatch(/1 characters/);
  expect(run('subset', font, '--unicodes', 'U+30', '--name-ids', '1', '-o', out)).toMatch(/unicode-range: U\+30\n/);
  expect(run('subset', font, '--text', 'a', '--name-ids', '0', '-o', out)).toMatch(/1 characters/);
});

test('check --allow-chars with a number does not crash', () => {
  const r = spawnSync(process.execPath, [cli, 'check', '--allow-chars', '123', '--mode', 'warn', '--cwd', tmp], {
    encoding: 'utf8',
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toMatch(/nothing to check/);
});

test('bad arguments exit non-zero with a message', () => {
  expect(() =>
    execFileSync(process.execPath, [cli, 'subset', font, '-o', join(tmp, 'x.ttf')], { stdio: 'pipe' }),
  ).toThrow(/must end in .woff2/);
});

test('build --core-threshold sets the rule for core, and rejects anything but auto or a share', () => {
  const root = join(tmp, 'site');
  cpSync(join(fixtures, 'sites/static-css'), root, { recursive: true });
  mkdirSync(join(root, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2'])
    cpSync(join(fixtures, 'fonts', f), join(root, 'fonts', f));
  const args = ['build', '--cwd', root, '--usage', join(fixtures, 'plans/static-css/usage.json'), '--no-remainder'];
  // The default measures, and this fixture then gets a coreChoice (the golden plan has it). A share doesn't.
  const { plan } = JSON.parse(run(...args, '--json', '--core-threshold', '0.5'));
  const inter = plan.faces.find((f: { id: string }) => f.id === 'inter-100-900-normal');
  expect(inter.status).toBe('planned');
  expect(inter.coreChoice).toBeUndefined();
  expect(inter.repair.count).toBe(5);
  for (const value of ['2', 'half'])
    expect(() => execFileSync(process.execPath, [cli, ...args, '--core-threshold', value], { stdio: 'pipe' })).toThrow(
      /--core-threshold must be 'auto' or a number between 0 and 1/,
    );
}, 120_000);
