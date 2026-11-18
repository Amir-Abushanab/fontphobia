import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  latestVersion,
  publishedAt,
  runCommand,
  updateCheckEnabled,
  updateNotice,
} from '../src/update.ts';

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('update notice', () => {
  it('compares major.minor.patch numerically', () => {
    expect(compareVersions('0.1.1', '0.7.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.8.0-next.1', '0.8.0')).toBe(0);
  });

  it('notices only an older version, with the command for the package manager in use', () => {
    expect(updateNotice('0.7.0', '0.7.0')).toBeUndefined();
    expect(updateNotice('0.8.0', '0.7.0')).toBeUndefined();
    expect(updateNotice('0.7.0', undefined)).toBeUndefined();
    const n = updateNotice('0.1.1', '0.7.0', 'pnpm/12.9.1 npm/? node/v24.0.0 darwin arm64')!;
    expect(n).toContain('fontphobia 0.7.0 is out; this run is 0.1.1');
    expect(n).toContain('`pnpm dlx fontphobia@0.7.0`');
    expect(runCommand('0.7.0', 'npm/11.0.0 node/v24.0.0')).toBe('npx fontphobia@0.7.0');
    expect(runCommand('0.7.0', 'bun/1.3.0')).toBe('bunx fontphobia@0.7.0');
    expect(runCommand('0.7.0', 'yarn/4.0.0')).toBe('yarn dlx fontphobia@0.7.0');
    expect(runCommand('0.7.0')).toBe('pnpm dlx fontphobia@0.7.0');
  });

  it('reads the registry answer and gives up quietly on anything else', async () => {
    expect(await latestVersion(answer(200, { version: '0.7.0' }))).toBe('0.7.0');
    expect(await latestVersion(answer(404, {}))).toBeUndefined();
    expect(await latestVersion(answer(200, { version: 7 }))).toBeUndefined();
    const fail = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await latestVersion(fail)).toBeUndefined();
    const slow = ((_: unknown, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(await latestVersion(slow, 20)).toBeUndefined();
  });

  it('tells a pnpm run of a release under a week old what to do when the cooldown refuses it', async () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    const pnpm = 'pnpm/12.9.1 npm/? node/v24.0.0';
    const hint = /younger than your `minimumReleaseAge`, run it from outside the project with `--cwd`/;
    expect(updateNotice('0.7.0', '0.8.0', pnpm, new Date('2026-11-18T00:00:00Z'), now)).toMatch(hint);
    expect(updateNotice('0.7.0', '0.8.0', pnpm, new Date('2026-11-10T00:00:00Z'), now)).not.toMatch(hint);
    expect(updateNotice('0.7.0', '0.8.0', pnpm, undefined, now)).not.toMatch(hint);
    expect(updateNotice('0.7.0', '0.8.0', 'npm/11.0.0', new Date('2026-11-18T00:00:00Z'), now)).not.toMatch(hint);
    expect(await publishedAt('0.8.0', answer(200, { time: { '0.8.0': '2026-11-18T00:00:00.000Z' } }))).toEqual(
      new Date('2026-11-18T00:00:00Z'),
    );
    expect(await publishedAt('0.8.0', answer(200, { time: {} }))).toBeUndefined();
    expect(await publishedAt('0.8.0', answer(500, {}))).toBeUndefined();
  });

  it('never runs in CI, without a terminal, or when turned off', () => {
    expect(updateCheckEnabled({}, true)).toBe(true);
    expect(updateCheckEnabled({}, false)).toBe(false);
    expect(updateCheckEnabled({ CI: 'true' }, true)).toBe(false);
    expect(updateCheckEnabled({ FONTPHOBIA_NO_UPDATE_CHECK: '1' }, true)).toBe(false);
    expect(updateCheckEnabled({ NO_UPDATE_NOTIFIER: '1' }, true)).toBe(false);
  });
});
