// The shared half of every framework integration (§13): `check` once the framework has written its
// HTML, failing the build (or warning) when the subsets no longer fit the site. Node builtins only:
// the check itself is loaded at the end of the build (check-runtime).
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
}

export interface Logger { info(m: string): void; warn(m: string): void }
export const consoleLogger: Logger = { info: (m) => console.log(m), warn: (m) => console.warn(m) };

/**
 * Run `check` for the project at `root` against the built site in `outputDir`; throws in error mode.
 * It runs in a child Node process: the frameworks load their plugins through bundlers and
 * transpilers (Vite's config loader, Docusaurus's jiti in a vm context) that can't load the font
 * engine, and a process boundary is the one thing they all leave alone.
 */
export async function postBuildCheck(root: string, outputDir: string | undefined, o: FontphobiaCheckOptions = {}, log: Logger = consoleLogger): Promise<void> {
  // Next to this file: check-runtime.mjs when bundled (dist/), check-runtime.ts in the source tree.
  const built = fileURLToPath(new URL('./check-runtime.mjs', import.meta.url));
  const script = existsSync(built) ? built : fileURLToPath(new URL('./check-runtime.ts', import.meta.url));
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, JSON.stringify({ root, outputDir, o })], { maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: (stdout + stderr).trimEnd() });
    });
  });
  const lines = r.out.split('\n');
  const level = lines[0] === 'warn' ? 'warn' : 'info';
  const text = lines.slice(1).join('\n') || r.out;
  if (r.code) throw new Error(text);
  log[level](text);
}
