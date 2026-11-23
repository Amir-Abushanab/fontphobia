// After a write: the project's own formatter over the text files fontphobia touched.
//
// What fontphobia writes can't be formatted in advance. The same long `unicode-range` is wrapped
// three different ways by oxfmt, Prettier and Biome, each by the project's print width, quotes and
// indentation; a rewritten `document.fonts.load()` call is one long line any of them would break.
// So a project with a format check in CI failed it after every run (principlestash.com). Running
// the formatter the project already uses is the one answer that holds for all of them, and `build`
// reads its own output back whatever whitespace it is in.
//
// Only a formatter the project declares, from its own node_modules: nothing is downloaded, and a
// project without one is left exactly as written. A formatter that fails, or that ignores a file,
// changes nothing and is not an error.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export interface Formatter {
  name: string;
  /** The executable, and the arguments that come before the file. */
  command: string;
  args: string[];
}

const KNOWN: { name: string; pkg: string; bin: string; configs: string[]; args: string[] }[] = [
  { name: 'oxfmt', pkg: 'oxfmt', bin: 'oxfmt', configs: ['.oxfmtrc.json', '.oxfmtrc.jsonc'], args: [] },
  {
    name: 'Prettier',
    pkg: 'prettier',
    bin: 'prettier',
    configs: [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.yaml',
      '.prettierrc.yml',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs',
      'prettier.config.ts',
    ],
    args: ['--write', '--ignore-unknown', '--log-level', 'silent'],
  },
  {
    name: 'Biome',
    pkg: '@biomejs/biome',
    bin: 'biome',
    configs: ['biome.json', 'biome.jsonc'],
    args: ['format', '--write', '--no-errors-on-unmatched'],
  },
  {
    name: 'dprint',
    pkg: 'dprint',
    bin: 'dprint',
    configs: ['dprint.json', 'dprint.jsonc', '.dprint.json'],
    args: ['fmt'],
  },
];

/** `root` and the directories above it: a workspace keeps its formatter at the top. */
function* upFrom(root: string): Generator<string> {
  for (let dir = root; ; dir = dirname(dir)) {
    yield dir;
    if (dirname(dir) === dir) return;
  }
}

const declares = (dir: string, pkg: string): boolean => {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    return !!(json.devDependencies?.[pkg] ?? json.dependencies?.[pkg]);
  } catch {
    return false;
  }
};

/**
 * The formatter this project uses: one it declares in a package.json, or has a config file for, at
 * `root` or above, and whose executable is installed there. The first of oxfmt, Prettier, Biome
 * and dprint that is.
 */
export function findFormatter(root: string): Formatter | undefined {
  for (const known of KNOWN) {
    let used = false;
    for (const dir of upFrom(root)) {
      used ||= declares(dir, known.pkg) || known.configs.some((c) => existsSync(join(dir, c)));
      const bin = join(dir, 'node_modules', '.bin', known.bin + (process.platform === 'win32' ? '.cmd' : ''));
      if (used && existsSync(bin)) return { name: known.name, command: bin, args: known.args };
    }
  }
  return undefined;
}

const run = promisify(execFile);

/**
 * Format `files` (project-relative) in place, one at a time so a file the formatter refuses or
 * ignores doesn't stop the rest. Returns the ones it changed.
 */
export async function formatFiles(root: string, files: string[], formatter: Formatter): Promise<string[]> {
  const changed: string[] = [];
  for (const file of new Set(files)) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    try {
      await run(formatter.command, [...formatter.args, file], {
        cwd: root,
        shell: process.platform === 'win32',
        timeout: 60_000,
      });
    } catch {
      continue; // not its kind of file, or in its ignore list
    }
    if (readFileSync(path, 'utf8') !== before) changed.push(file);
  }
  return changed;
}
