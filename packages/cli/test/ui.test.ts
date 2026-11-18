import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { ansiStyle, bar, colorEnabled, fit, highlight, visible } from '../src/ui.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (args: string[], env: Record<string, string | undefined> = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('colors', () => {
  const keep = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  const set = (k: 'NO_COLOR' | 'FORCE_COLOR', v?: string) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  it('follows the terminal, NO_COLOR, FORCE_COLOR and --no-color', () => {
    try {
      set('NO_COLOR');
      set('FORCE_COLOR');
      expect(colorEnabled({ isTTY: false })).toBe(false);
      set('FORCE_COLOR', '1');
      expect(colorEnabled({ isTTY: false })).toBe(true);
      expect(colorEnabled({ isTTY: true }, false)).toBe(false);
      set('FORCE_COLOR', '0');
      expect(colorEnabled({ isTTY: true })).toBe(false);
      set('FORCE_COLOR');
      set('NO_COLOR', '1');
      expect(colorEnabled({ isTTY: true })).toBe(false);
    } finally {
      set('NO_COLOR', keep.NO_COLOR);
      set('FORCE_COLOR', keep.FORCE_COLOR);
    }
  });

  it('plain style leaves text alone', () => {
    const s = ansiStyle(false);
    expect(s.red('x') + s.bold('y')).toBe('xy');
    expect(ansiStyle(true).red('x')).toBe('\x1b[31mx\x1b[39m');
  });
});

describe('layout helpers', () => {
  const s = ansiStyle(true);
  it('fit cuts by visible width and keeps escape codes intact', () => {
    const t = `${s.green('abcdef')}ghij`;
    expect(visible(fit(t, 5))).toBe(5);
    expect(fit(t, 5).startsWith('\x1b[32mabcd…')).toBe(true);
    expect(fit('short', 10)).toBe('short');
  });

  it('bar fills its share', () => {
    const p = ansiStyle(false);
    expect(bar(5, 10, 10, p)).toBe('━━━━━─────');
    expect(bar(0, 0, 4, p)).toBe('────');
    expect(bar(20, 10, 4, p)).toBe('━━━━');
  });

  it('highlight colors headings, failures and savings without changing the text', () => {
    const text =
      'Font bytes per page\n  median 10 KB → 5 KB (50% less)\n  regression: /a: width changed\nVerify failed.';
    const out = highlight(text, s);
    expect(visible(out)).toBe(text.length);
    expect(stripVTControlCharacters(out)).toBe(text);
    expect(out).toContain('\x1b[1mFont bytes per page');
    expect(out).toContain(s.green('50% less'));
    expect(out).toContain(s.bold(s.red('Verify failed.')));
    // "0 regression(s)" isn't a failure.
    expect(highlight('  3 identical, 0 regression(s)', s)).not.toContain('\x1b[31m');
  });
});

describe('command line', () => {
  it('names an unknown command and suggests the closest one', () => {
    const r = run(['verfy']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown command `verfy`. Did you mean `verify`?');
  });

  it('help shows usage, the default command and examples, without "(default: true)"', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('$ fontphobia [command] [options]');
    expect(r.out).toMatch(/\(none\) +Audit the site/);
    expect(r.out).toContain('Examples');
    expect(r.out).toContain('--no-color');
    expect(r.out).not.toContain('(default: true)');
    expect(run(['build', '--help']).out).not.toContain('Examples');
  });

  it('errors are plain without a terminal and colored with FORCE_COLOR', () => {
    expect(run(['nope']).err).toMatch(/^fontphobia: unknown command/);
    expect(run(['nope'], { FORCE_COLOR: '1' }).err).toContain('\x1b[31mfontphobia:\x1b[39m');
    expect(run(['nope', '--no-color'], { FORCE_COLOR: '1' }).err).toMatch(/^fontphobia: /);
  });
});
