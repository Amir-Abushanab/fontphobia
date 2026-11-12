import { readdirSync, readFileSync } from 'node:fs';
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

  it('packages/cli/CHANGELOG.md has a section for the package version', () => {
    expect(read('packages/cli/CHANGELOG.md')).toMatch(new RegExp(`^## ${version.replace(/[.+]/g, '\\$&')}$`, 'm'));
  });

  // `changeset version` skips a changeset that names a private package and leaves the file behind,
  // so a change recorded against @fontphobia/core or @fontphobia/crawler would never be released.
  it('every changeset names fontphobia and nothing else', () => {
    const bad: string[] = [];
    for (const f of readdirSync(new URL('.changeset/', root)).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
      const front = /^---\n([\s\S]*?)\n?---/.exec(read(`.changeset/${f}`));
      if (!front) { bad.push(`${f}: no frontmatter`); continue; }
      for (const line of front[1]!.split('\n').filter((l) => l.trim())) {
        if (!/^(["']?)fontphobia\1: (patch|minor|major)$/.test(line.trim())) bad.push(`${f}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
