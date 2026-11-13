// `fontphobia auto` and the integrations' `auto` option: subset the built site in its output
// directory. Static by default (no browser); `crawl` audits the output in Chrome first.
import { join, relative, resolve } from 'node:path';
import {
  autoSubset,
  detectProject,
  ensureFontphobiaDir,
  findSite,
  type AutoResult,
  type PlanConfig,
  type UsageFileJson,
  verifyStatic,
} from '@fontphobia/core';
import type { VerifyResult } from '@fontphobia/crawler';
import { loadConfig, selfUrl } from './config.ts';
import pkg from '../package.json' with { type: 'json' };

export interface AutoRunOptions {
  root: string;
  /** The built site (default: config `dist`, else what the framework profile finds). */
  outDir?: string;
  crawl?: boolean;
  /** Where the split rules go (default: config `autoRules`, else `inline`). */
  rules?: 'inline' | 'linked';
  /** False: plan only. */
  write?: boolean;
  /** On top of the config's. */
  allow?: string[];
  coreThreshold?: number | 'auto';
  remainder?: boolean;
  /** Also load the pages before and after in Chrome and compare them (`verify`'s browser stage). */
  verify?: boolean;
  log?: (m: string) => void;
}

export interface AutoRun {
  result: AutoResult;
  outDir: string;
  /** crawl: pages that didn't load. */
  failed: Record<string, string>;
  /** With `verify`, when something was written. */
  verify?: VerifyResult;
}

export async function runAuto(o: AutoRunOptions): Promise<AutoRun> {
  const root = resolve(o.root);
  const log = o.log ?? (() => {});
  const { config, file } = await loadConfig(root, selfUrl(import.meta.url));
  if (file) log(`config: ${file}`);
  const given = o.outDir ?? config.dist;
  let outDir = given === undefined ? undefined : resolve(root, given);
  if (!outDir) {
    const site = findSite(detectProject(root));
    if (site?.mode !== 'static' || !site.dir)
      throw new Error(
        'No built static output found. `fontphobia auto` works on prerendered HTML: build the site first, or pass --dist.',
      );
    outDir = site.dir;
  }
  const cfg: PlanConfig = {
    coreThreshold: o.coreThreshold ?? config.coreThreshold,
    remainder: o.remainder === false ? false : config.remainder,
    allow: [...(config.allow ?? []), ...(o.allow ?? [])],
    locales: config.locales,
    rename: config.rename,
    licenses: config.licenses,
  };
  let usage: UsageFileJson | undefined;
  let failed: Record<string, string> = {};
  if (o.crawl) {
    const { audit } = await import('@fontphobia/crawler');
    // The visit cache lives in the project, so a page is visited again only when something it loads changed.
    ensureFontphobiaDir(root);
    const a = await audit({
      root,
      // Serve this output as it is: never rebuild, never use an older kept build.
      dist: relative(root, outDir) || '.',
      inPlace: true,
      fontphobiaVersion: pkg.version,
      log,
      viewports: config.viewports,
      locales: config.locales,
      maxPages: config.maxPages,
      pages: config.pages,
      ignore: config.ignore,
      storageState: config.auth?.storageState ? resolve(root, config.auth.storageState) : undefined,
      privatePages: config.auth?.pages,
    });
    usage = a.usage as unknown as UsageFileJson;
    failed = a.crawl.failed;
  }
  log(o.crawl ? 'planning…' : `reading ${relative(root, outDir) || '.'}…`);
  const result = await autoSubset({
    root,
    outDir,
    usage,
    config: cfg,
    version: pkg.version,
    write: o.write,
    rules: o.rules ?? config.autoRules,
  });
  let verify: VerifyResult | undefined;
  if (o.verify && result.written && Object.keys(result.manifest.entries).length) {
    // "Before" is this same output with each split rule swapped back to the original declaration.
    const { verifyBrowser, DEFAULT_VIEWPORTS } = await import('@fontphobia/crawler');
    log('comparing the pages before and after in Chrome…');
    const st = await verifyStatic(outDir, result.usage, result.manifest);
    const browser = await verifyBrowser({
      root: outDir,
      usage: result.usage,
      manifest: result.manifest,
      staticResult: st,
      dist: '.',
      inPlace: true,
      sourcesInOutput: true,
      viewports: config.verify?.viewports ?? (result.usage.meta.viewports.length ? undefined : DEFAULT_VIEWPORTS),
      dprs: config.verify?.dprs,
      browsers: config.verify?.browsers,
      maxPages: config.verify?.maxPages,
      mask: config.verify?.mask,
      timeout: config.verify?.timeout,
      ignore: config.ignore,
      outDir: join(root, '.fontphobia', 'verify'),
      log,
    });
    // Static usage can't predict text that CSS or scripts generate, so an extended or rest file may
    // load where it says none is needed. That costs bytes, not pixels: reported, not a failure.
    const unpredicted = o.crawl ? [] : browser.loads;
    const shown = o.crawl
      ? browser
      : {
          ...browser,
          loads: [],
          ok:
            !browser.rejected.length &&
            !browser.comparisons.some((c) => c.class === 'regression' || c.class === 'failed'),
        };
    // The original rule is the fallback and never matches a character, so nothing should fetch its font.
    const still = browser.originals ?? [];
    if (still.length) {
      const files = [...new Set(still.map((x) => x.file))];
      result.notes.push(
        `${files.join(', ')} still downloaded on ${new Set(still.map((x) => x.page)).size} page(s) next to its subset files: a preload or a script asks for it by name. The pages render the same`,
      );
    }
    if (unpredicted.length)
      result.notes.push(
        `${unpredicted.length} extended or rest file load(s) the static reading didn't predict (text that CSS or scripts generate); the pages render the same`,
      );
    verify = { static: { ...st, outputs: st.outputs.size }, browser: shown, ok: st.ok && shown.ok };
  }
  return { result, outDir, failed, verify };
}
