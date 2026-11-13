// What the framework integrations run once the HTML exists (§13), in a child process started by
// `integration.ts`: `node check-runtime.mjs '{"root":…,"outputDir":…,"o":{…}}'`. Prints the level
// (`info` or `warn`) on the first line and the report after it; exits 1 when the build should fail.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkProject, formatCheck, type UsageFileJson } from '@fontphobia/core';
import { loadConfig, selfUrl } from './config.ts';
import type { FontphobiaCheckOptions, Logger } from './integration.ts';

export async function runCheck(
  root: string,
  outputDir: string | undefined,
  opts: FontphobiaCheckOptions,
  log: Logger,
): Promise<void> {
  // Options given to the integration win; the rest come from fontphobia.config's `check`.
  // A config that fails to load fails the check with its error.
  const { config } = await loadConfig(root, selfUrl(import.meta.url));
  // The config's `auto`, for an integration that wasn't given the option (the Next adapter takes none).
  if (opts.auto === undefined && config.auto) {
    const [{ runAuto }, { formatAuto }] = await Promise.all([import('./auto-run.ts'), import('@fontphobia/core')]);
    const { result, outDir, failed } = await runAuto({ root, outDir: outputDir, crawl: config.auto === 'crawl' });
    const n = Object.keys(failed).length;
    log.info(`${formatAuto(result, relative(root, outDir) || '.')}${n ? `\n${n} page(s) could not be loaded` : ''}`);
    return;
  }
  const fromConfig = config.check ?? {};
  const o = {
    ...fromConfig,
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  } as FontphobiaCheckOptions;
  const usageFile = join(root, '.fontphobia', 'usage.json');
  const usage = existsSync(usageFile) ? (JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson) : undefined;
  const r = await checkProject({ root, outputDir, usage, allowChars: o.allowChars, strict: o.strict });
  const text = formatCheck(r);
  if (r.noManifest) {
    log.warn(text);
    return;
  }
  if (!r.issues.length) {
    log.info(text);
    return;
  }
  if (r.ok || o.mode === 'warn') {
    log.warn(text);
    return;
  }
  throw new Error(text);
}

// As a child process: the arguments are one JSON object.
const arg = process.argv[2];
if (arg && /check-runtime\.(m?js|ts)$/.test(process.argv[1] ?? '')) {
  const { root, outputDir, o } = JSON.parse(arg) as { root: string; outputDir?: string; o: FontphobiaCheckOptions };
  let level = 'info';
  const out: string[] = [];
  runCheck(root, outputDir, o, {
    info: (m) => out.push(m),
    warn: (m) => {
      level = 'warn';
      out.push(m);
    },
  })
    .then(() => {
      process.stdout.write(`${level}\n${out.join('\n')}\n`);
    })
    .catch((e: Error) => {
      process.stdout.write(`error\n${e.message}\n`);
      process.exitCode = 1;
    });
}
