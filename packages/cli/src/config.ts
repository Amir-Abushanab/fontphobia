// fontphobia.config.{ts,mts,mjs,js,json} (§3). TypeScript configs load through Node's type
// stripping (Node ≥ 22.18). `import { defineConfig } from 'fontphobia'` resolves to this CLI even
// when the project doesn't install fontphobia (the pnpm dlx case).
import { existsSync, readFileSync } from 'node:fs';
import module from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Config {
  dist?: string;
  build?: string;
  start?: string;
  url?: string;
  pages?: string[];
  ignore?: string[];
  auth?: { storageState?: string; pages?: string[] };
  viewports?: number[];
  locales?: string[];
  maxPages?: number;
  coreThreshold?: number;
  remainder?: boolean;
  allow?: string[];
  rename?: Record<string, string>;
  licenses?: { allow?: string[] };
  /** `verify` (§10.3): engines, page cap (default 200), viewports, device pixel ratios, masks and the load timeout. */
  /** `check` (§12): characters never reported (strings that never render), and whether a stale build fails. */
  check?: { allowChars?: string; mode?: 'warn' | 'error'; /** Fail on warnings too (characters that would load the rest file). */ strict?: boolean };
  verify?: { browsers?: ('chromium' | 'firefox' | 'webkit' | 'linux-chromium' | 'linux-firefox' | 'linux-webkit')[]; hinting?: boolean; maxPages?: number; viewports?: number[]; dprs?: number[]; /** Selectors hidden in both loads. */ mask?: string[]; /** Seconds a page may take to load. */ timeout?: number };
}

export const defineConfig = (c: Config): Config => c;

const NAMES = ['fontphobia.config.ts', 'fontphobia.config.mts', 'fontphobia.config.mjs', 'fontphobia.config.js', 'fontphobia.config.json'];

let hooked = false;
function hookSelfImport(selfUrl: string) {
  const reg = (module as unknown as { registerHooks?: (h: unknown) => void }).registerHooks;
  if (hooked || !reg) return;
  hooked = true;
  reg({
    resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) {
      if (specifier === 'fontphobia') return { url: selfUrl, shortCircuit: true, format: selfUrl.endsWith('.ts') ? 'module-typescript' : 'module' };
      return next(specifier, context);
    },
  });
}

export async function loadConfig(root: string, selfUrl: string): Promise<{ config: Config; file?: string }> {
  for (const name of NAMES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    if (name.endsWith('.json')) return { config: JSON.parse(readFileSync(file, 'utf8')), file: name };
    hookSelfImport(selfUrl);
    // A project without "type": "module" makes Node warn that it reparsed the config as ESM; that's expected here.
    const emit = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      const code = typeof rest[0] === 'object' && rest[0] ? (rest[0] as { code?: string }).code : rest[1];
      if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
      return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
      const mod = await import(pathToFileURL(file).href);
      return { config: (mod.default ?? mod) as Config, file: name };
    } catch (e) {
      const msg = (e as Error).message;
      if (/Unknown file extension "\.m?ts"/.test(msg)) throw new Error(`${name}: this Node version can't load TypeScript configs; use Node ≥ 22.18 or rename it to fontphobia.config.mjs`);
      throw new Error(`${name}: ${msg}`);
    } finally {
      process.emitWarning = emit;
    }
  }
  return { config: {} };
}
