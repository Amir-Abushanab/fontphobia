import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const font = fileURLToPath(new URL('../../../fixtures/fonts/InterVariable.ttf', import.meta.url));
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

test('bad arguments exit non-zero with a message', () => {
  expect(() => execFileSync(process.execPath, [cli, 'subset', font, '-o', join(tmp, 'x.ttf')], { stdio: 'pipe' })).toThrow(/must end in .woff2/);
});
