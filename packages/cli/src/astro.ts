// `fontphobia/astro` (§13): the Vite guards, the dev warning, and `check` in `astro:build:done`, once
// the HTML exists. Add it to astro.config: `integrations: [fontphobia()]`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, formatCheck, type UsageFileJson } from '@fontphobia/core';
import { loadConfig, selfUrl } from './config.ts';
import { postBuildCheck } from './integration.ts';
import { devWarningScript, fontphobia as vitePlugin } from './vite.ts';

export interface FontphobiaAstroOptions {
  /**
   * `error` (default) fails the build when the site would render differently or the files no longer
   * match the build; `warn` only logs. Characters that would load the rest file render correctly, so
   * they only warn, unless `strict`.
   */
  mode?: 'warn' | 'error';
  strict?: boolean;
  /** Characters `check` never reports. */
  allowChars?: string;
  /** Subset the build output on every build instead of checking committed subsets (see `fontphobia auto`). */
  auto?: boolean | 'static' | 'crawl';
}

interface Logger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export default function fontphobia(o: FontphobiaAstroOptions = {}) {
  let root = process.cwd();
  return {
    name: 'fontphobia',
    hooks: {
      'astro:config:setup': ({
        config,
        command,
        updateConfig,
        injectScript,
      }: {
        config: { root: URL };
        command: string;
        updateConfig: (c: unknown) => void;
        injectScript: (stage: 'page', code: string) => void;
      }) => {
        root = fileURLToPath(config.root);
        updateConfig({ vite: { plugins: [vitePlugin({ root, devWarnings: false })] } });
        if (command === 'dev') {
          const s = devWarningScript(root);
          if (s) injectScript('page', s);
        }
      },
      'astro:build:done': async ({ dir, logger }: { dir: URL; logger: Logger }) => {
        if (o.auto) {
          await postBuildCheck(root, fileURLToPath(dir), { auto: o.auto }, logger);
          return;
        }
        // Options given to the integration win; the rest come from fontphobia.config's `check` (as in check-runtime).
        const fromConfig = (await loadConfig(root, selfUrl(import.meta.url))).config.check ?? {};
        const c = {
          ...fromConfig,
          ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
        } as FontphobiaAstroOptions;
        const usageFile = join(root, '.fontphobia', 'usage.json');
        const usage = existsSync(usageFile)
          ? (JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson)
          : undefined;
        const r = await checkProject({
          root,
          outputDir: fileURLToPath(dir),
          usage,
          allowChars: c.allowChars,
          strict: c.strict,
        });
        const text = formatCheck(r).replace(/^fontphobia: /, '');
        if (r.noManifest) {
          logger.warn(text);
          return;
        }
        if (!r.issues.length) {
          logger.info(text);
          return;
        }
        if (r.ok) {
          logger.warn(text);
          return;
        }
        if (c.mode === 'warn') logger.warn(text);
        else throw new Error(`fontphobia: ${text}`);
      },
    },
  };
}
