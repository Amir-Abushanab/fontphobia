// What the framework integrations run with `auto` set, once the HTML exists, in a child process
// started by `integration.ts`: `node auto-runtime.mjs '{"root":…,"outputDir":…,"crawl":…}'`. Prints
// the level on the first line and the report after it; exits 1 when the build should fail.
import { relative } from 'node:path';
import { formatAuto } from '@fontphobia/core';
import { runAuto } from './auto-run.ts';

const arg = process.argv[2];
if (arg && /auto-runtime\.(m?js|ts)$/.test(process.argv[1] ?? '')) {
  const { root, outputDir, crawl } = JSON.parse(arg) as { root: string; outputDir?: string; crawl?: boolean };
  runAuto({ root, outDir: outputDir, crawl })
    .then(({ result, outDir, failed }) => {
      const n = Object.keys(failed).length;
      process.stdout.write(
        `info\n${formatAuto(result, relative(root, outDir) || '.')}${n ? `\n${n} page(s) could not be loaded` : ''}\n`,
      );
    })
    .catch((e: Error) => {
      process.stdout.write(`error\n${e.message}\n`);
      process.exitCode = 1;
    });
}
