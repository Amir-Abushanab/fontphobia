// The shared half of every framework integration (§13): `check` once the framework has written its
// HTML, failing the build (or warning) when the subsets no longer fit the site. With `auto`, the
// output is subset there instead (auto-runtime). Node builtins only: either one is loaded at the
// end of the build.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface FontphobiaCheckOptions {
  /**
   * `error` (default) fails the build when the site would render differently or the files no longer
   * match the build; `warn` only logs. Characters that would load the rest file render correctly, so
   * they only warn, unless `strict`.
   */
  mode?: 'warn' | 'error';
  strict?: boolean;
  /** Characters `check` never reports. */
  allowChars?: string;
  /**
   * Subset the fonts in the build output on every build instead of checking committed subsets:
   * nothing to run by hand or commit. `true` or `'static'` reads the built text (no browser);
   * `'crawl'` measures each face in Chrome, which has to be installed where the build runs.
   */
  auto?: boolean | 'static' | 'crawl';
}

export interface Logger {
  info(m: string): void;
  warn(m: string): void;
}
const consoleLogger: Logger = { info: (m) => console.log(m), warn: (m) => console.warn(m) };

/**
 * Run `check` for the project at `root` against the built site in `outputDir` (or, with `auto`,
 * subset that output); throws in error mode.
 * It runs in a child Node process: the frameworks load their plugins through bundlers and
 * transpilers (Vite's config loader, Docusaurus's jiti in a vm context) that can't load the font
 * engine, and a process boundary is the one thing they all leave alone.
 */
export async function postBuildCheck(
  root: string,
  outputDir: string | undefined,
  o: FontphobiaCheckOptions = {},
  log: Logger = consoleLogger,
): Promise<void> {
  // Next to this file: check-runtime.mjs when bundled (dist/), check-runtime.ts in the source tree.
  const name = o.auto ? 'auto-runtime' : 'check-runtime';
  const built = fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
  const script = existsSync(built) ? built : fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
  const payload = o.auto ? { root, outputDir, crawl: o.auto === 'crawl' } : { root, outputDir, o };
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, JSON.stringify(payload)], { maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: (stdout + stderr).trimEnd() });
    });
  });
  const lines = r.out.split('\n');
  const level = lines[0] === 'warn' ? 'warn' : 'info';
  const text = lines.slice(1).join('\n') || r.out;
  if (r.code) throw new Error(text);
  log[level](text);
}
