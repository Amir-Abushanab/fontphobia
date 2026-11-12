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
  /** `check` (§12): characters never reported (strings that never render), and whether a stale build fails. */
  check?: {
    allowChars?: string;
    mode?: 'warn' | 'error';
    /** Fail on warnings too (characters that would load the rest file). */ strict?: boolean;
  };
  /** `verify` (§10.3): engines, page cap (default 200), viewports, device pixel ratios, masks and the load timeout. */
  verify?: {
    browsers?: ('chromium' | 'firefox' | 'webkit' | 'linux-chromium' | 'linux-firefox' | 'linux-webkit')[];
    hinting?: boolean;
    maxPages?: number;
    viewports?: number[];
    dprs?: number[];
    /** Selectors hidden in both loads. */ mask?: string[];
    /** Seconds a page may take to load. */ timeout?: number;
  };
}

export const defineConfig = (c: Config): Config => c;

/** Where the bare specifier `fontphobia` resolves while a config loads: index.ts in the source tree, index.mjs in dist. `from` is the caller's import.meta.url. */
export const selfUrl = (from: string) => new URL(from.endsWith('.ts') ? './index.ts' : './index.mjs', from).href;

type Kind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | 'record'
  | { enum: readonly string[]; array?: boolean };
const ENGINES = ['chromium', 'firefox', 'webkit', 'linux-chromium', 'linux-firefox', 'linux-webkit'];
const ALLOW = ['limit-axes', 'drop-hinting', 'split-shaping', 'drop-hint-refs', 'self-host', 'tighten', 'eject'];
const SCHEMA: Record<string, Kind | Record<string, Kind>> = {
  dist: 'string',
  build: 'string',
  start: 'string',
  url: 'string',
  pages: 'string[]',
  ignore: 'string[]',
  auth: { storageState: 'string', pages: 'string[]' },
  viewports: 'number[]',
  locales: 'string[]',
  maxPages: 'number',
  coreThreshold: 'number',
  remainder: 'boolean',
  allow: { enum: ALLOW, array: true },
  rename: 'record',
  licenses: { allow: 'string[]' },
  check: { allowChars: 'string', mode: { enum: ['warn', 'error'] }, strict: 'boolean' },
  verify: {
    browsers: { enum: ENGINES, array: true },
    hinting: 'boolean',
    maxPages: 'number',
    viewports: 'number[]',
    dprs: 'number[]',
    mask: 'string[]',
    timeout: 'number',
  },
};

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

function validate(name: string, c: unknown): void {
  const bad = (key: string, want: string) => {
    throw new Error(`${name}: "${key}" must be ${want}`);
  };
  const keys = (o: Record<string, unknown>, known: string[], at: string) => {
    for (const k of Object.keys(o)) {
      if (known.includes(k)) continue;
      const near = known
        .map((n) => [n, distance(k, n)] as const)
        .filter(([, d]) => d <= 2)
        .toSorted((a, b) => a[1] - b[1])[0];
      throw new Error(`${name}: unknown key "${at}${k}"${near ? `; did you mean "${at}${near[0]}"?` : ''}`);
    }
  };
  if (!isObj(c)) throw new Error(`${name}: the config must be an object`);
  keys(c, Object.keys(SCHEMA), '');
  const one = (key: string, v: unknown, k: Kind) => {
    if (typeof k === 'object') {
      const list = k.array
        ? Array.isArray(v) && v.every((x) => typeof x === 'string' && k.enum.includes(x))
        : typeof v === 'string' && k.enum.includes(v);
      if (!list) bad(key, `${k.array ? 'an array of ' : 'one of '}${k.enum.map((x) => `'${x}'`).join(', ')}`);
    } else if (
      k === 'string'
        ? typeof v !== 'string'
        : k === 'number'
          ? !isNum(v)
          : k === 'boolean'
            ? typeof v !== 'boolean'
            : k === 'string[]'
              ? !isStrs(v)
              : k === 'number[]'
                ? !(Array.isArray(v) && v.every(isNum))
                : !(isObj(v) && Object.values(v).every((x) => typeof x === 'string'))
    ) {
      bad(
        key,
        k === 'string[]'
          ? 'an array of strings'
          : k === 'number[]'
            ? 'an array of numbers'
            : k === 'record'
              ? 'an object of strings'
              : `a ${k}`,
      );
    }
  };
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof spec === 'string' || 'enum' in spec) {
      one(key, v, spec as Kind);
      continue;
    }
    if (!isObj(v)) bad(key, 'an object');
    keys(v as Record<string, unknown>, Object.keys(spec), `${key}.`);
    for (const [k2, kind] of Object.entries(spec))
      if ((v as Record<string, unknown>)[k2] !== undefined)
        one(`${key}.${k2}`, (v as Record<string, unknown>)[k2], kind);
  }
  const t = c.coreThreshold;
  if (t !== undefined && ((t as number) < 0 || (t as number) > 1)) bad('coreThreshold', 'a number between 0 and 1');
}

const NAMES = [
  'fontphobia.config.ts',
  'fontphobia.config.mts',
  'fontphobia.config.mjs',
  'fontphobia.config.js',
  'fontphobia.config.json',
];

let hooked = false;
function hookSelfImport(self: string) {
  const reg = (module as unknown as { registerHooks?: (h: unknown) => void }).registerHooks;
  if (hooked || !reg) return;
  hooked = true;
  reg({
    resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) {
      if (specifier === 'fontphobia')
        return { url: self, shortCircuit: true, format: self.endsWith('.ts') ? 'module-typescript' : 'module' };
      return next(specifier, context);
    },
  });
}

export async function loadConfig(root: string, self: string): Promise<{ config: Config; file?: string }> {
  for (const name of NAMES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    if (name.endsWith('.json')) {
      let config: Config;
      try {
        config = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`, { cause: e });
      }
      validate(name, config);
      return { config, file: name };
    }
    hookSelfImport(self);
    // A project without "type": "module" makes Node warn that it reparsed the config as ESM; that's expected here.
    const emit = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      const code = typeof rest[0] === 'object' && rest[0] ? (rest[0] as { code?: string }).code : rest[1];
      if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
      return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    let config: Config;
    try {
      const mod = await import(pathToFileURL(file).href);
      config = (mod.default ?? mod) as Config;
    } catch (e) {
      const msg = (e as Error).message;
      if (/Unknown file extension "\.m?ts"/.test(msg))
        throw new Error(
          `${name}: this Node version can't load TypeScript configs; use Node ≥ 22.18 or rename it to fontphobia.config.mjs`,
          { cause: e },
        );
      throw new Error(`${name}: ${msg}`, { cause: e });
    } finally {
      process.emitWarning = emit;
    }
    validate(name, config);
    return { config, file: name };
  }
  return { config: {} };
}
