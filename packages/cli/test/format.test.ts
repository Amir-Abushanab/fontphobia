// After a write, the project's own formatter runs over what fontphobia touched (format.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findFormatter, formatFiles } from '../src/format.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-format-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const bin = (name: string) => name + (process.platform === 'win32' ? '.cmd' : '');
function project(name: string, o: { deps?: string[]; bins?: string[]; files?: string[] } = {}) {
  const root = join(tmp, name);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: Object.fromEntries((o.deps ?? []).map((d) => [d, '1.0.0'])) }),
  );
  for (const b of o.bins ?? []) writeFileSync(join(root, 'node_modules/.bin', bin(b)), '');
  for (const f of o.files ?? []) writeFileSync(join(root, f), '{}');
  return root;
}

describe('which formatter a project uses', () => {
  it('is the one it declares and has installed', () => {
    const f = findFormatter(project('prettier', { deps: ['prettier'], bins: ['prettier'] }));
    expect(f?.name).toBe('Prettier');
    expect(f?.args).toContain('--write');
    expect(findFormatter(project('biome', { deps: ['@biomejs/biome'], bins: ['biome'] }))?.name).toBe('Biome');
  });

  it('is none when nothing is declared, even with an executable a dependency brought along', () => {
    expect(findFormatter(project('bare'))).toBeUndefined();
    expect(findFormatter(project('hoisted', { bins: ['prettier'] }))).toBeUndefined();
    // Declared, not installed: nothing to run, and nothing is downloaded.
    expect(findFormatter(project('missing', { deps: ['oxfmt'] }))).toBeUndefined();
  });

  it('counts a config file as using it, and looks above a workspace package', () => {
    expect(findFormatter(project('config', { bins: ['oxfmt'], files: ['.oxfmtrc.json'] }))?.name).toBe('oxfmt');
    const root = project('workspace', { deps: ['oxfmt'], bins: ['oxfmt'] });
    mkdirSync(join(root, 'apps/site'), { recursive: true });
    writeFileSync(join(root, 'apps/site/package.json'), '{}');
    expect(findFormatter(join(root, 'apps/site'))?.command).toBe(join(root, 'node_modules/.bin', bin('oxfmt')));
  });
});

describe('formatting what was written', () => {
  it('reports the files the formatter changed, and shrugs at the ones it refuses', async () => {
    const root = project('run');
    // A stand-in formatter: trims trailing spaces, and refuses .json the way an ignore list does.
    const script = join(root, 'fmt.mjs');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
if (file.endsWith('.json')) process.exit(1);
writeFileSync(file, readFileSync(file, 'utf8').replace(/ +$/gm, ''));
`,
    );
    writeFileSync(join(root, 'a.css'), 'a {}  \n');
    writeFileSync(join(root, 'b.css'), 'b {}\n');
    writeFileSync(join(root, 'm.json'), '{}  \n');
    const changed = await formatFiles(root, ['a.css', 'b.css', 'm.json', 'gone.css', 'a.css'], {
      name: 'stand-in',
      command: process.execPath,
      args: [script],
    });
    expect(changed).toEqual(['a.css']);
    expect(readFileSync(join(root, 'a.css'), 'utf8')).toBe('a {}\n');
    expect(readFileSync(join(root, 'm.json'), 'utf8')).toBe('{}  \n');
  });
});
