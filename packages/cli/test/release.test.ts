import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const { version } = JSON.parse(read('packages/cli/package.json')) as { version: string };

describe('release metadata', () => {
  for (const file of ['README.md', 'docs/ci.md']) {
    it(`${file} pins fontphobia@${version} everywhere`, () => {
      const pins = [...read(file).matchAll(/fontphobia@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g)].map((m) => m[1]);
      expect(pins.length).toBeGreaterThan(0);
      expect(pins.filter((v) => v !== version)).toEqual([]);
    });
  }

  it('CHANGELOG.md has a section for the package version', () => {
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`^## ${version.replace(/[.+]/g, '\\$&')}$`, 'm'));
  });
});
