#!/usr/bin/env node
// fontphobia CLI: audit (M2), build and revert (M3–M4), verify (M5), check (M6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { cac } from 'cac';
import {
  checkProject, checkUsage, formatCheck, ensureFontphobiaDir, FONTPHOBIA_DIR,
  auditMarkdown, buildProject, canonicalJson, formatAudit, formatEdits, formatPlan, kb, MANIFEST_FILE, revertProject, type UsageFileJson, formatInspection, formatUnicodeRange, harfbuzzVersion, inspectFont, parseUnicodeRange,
  rangesFromCodePoints, subsetFont, codePointsOf, type AxisSetting, type SubsetOptions,
} from '@fontphobia/core';
import { loadConfig } from './config.ts';
import { applyKit, readUsage, revertKits } from './apply-kit.ts';
import pkg from '../package.json' with { type: 'json' };

const cli = cac('fontphobia');

cli
  .command('inspect <font>', "Show a font's tables, axes, features, hinting and sizes")
  .option('--json', 'Machine-readable output')
  .action(async (file: string, o: { json?: boolean }) => {
    const info = await inspectFont(new Uint8Array(readFileSync(file)));
    process.stdout.write((o.json ? JSON.stringify(info, null, 2) : formatInspection(info)) + '\n');
  });

cli
  .command('subset <font>', 'Low-level: subset one font to a validated WOFF2 (no crawl, no CSS edits)')
  .option('-o, --output <file>', 'Output file (.woff2)')
  .option('--unicodes <ranges>', 'Code points to keep, e.g. "U+20-7E,U+A0-FF" (default: all)')
  .option('--text <text>', 'Also keep the characters of this text')
  .option('--features <list>', '"default" (HarfBuzz defaults), "*", "+tnum,+ss01" (defaults plus these) or "kern,liga" (only these)', { default: 'default' })
  .option('--name-ids <list>', 'name IDs to keep, or "*" (default 0-6,13,14,16,17,25)')
  .option('--axis <tag=value>', 'Pin an axis (wght=400) or limit it (wght=400:700). Changes widths slightly. Repeatable')
  .option('--no-hinting', 'Drop TrueType hinting (changes rendering on Windows and Linux)')
  .action(async (file: string, o: { output?: string; unicodes?: string; text?: string; features: string; nameIds?: string; axis?: string | string[]; hinting: boolean }) => {
    if (!o.output) throw new Error('--output is required');
    if (extname(o.output) !== '.woff2') throw new Error('--output must end in .woff2');
    const opts: SubsetOptions = { unicodes: '*', hinting: o.hinting };
    if (o.unicodes || o.text) {
      const cps = new Set<number>(o.unicodes ? codePointsOf(parseUnicodeRange(o.unicodes)) : []);
      for (const ch of o.text ?? '') cps.add(ch.codePointAt(0)!);
      opts.unicodes = cps;
    }
    const f = o.features.trim();
    if (f === '*') opts.features = '*';
    else if (f !== 'default') {
      const tags = f.split(',').map((t) => t.trim()).filter(Boolean);
      opts.features = tags.every((t) => t.startsWith('+')) ? { add: tags.map((t) => t.slice(1)) } : { only: tags };
    }
    if (o.nameIds) opts.nameIds = o.nameIds === '*' ? '*' : o.nameIds.split(',').map(Number);
    for (const a of [o.axis ?? []].flat()) {
      const m = a.match(/^([\x20-\x7e]{4})=(-?[\d.]+)(?::(-?[\d.]+))?$/);
      if (!m) throw new Error(`Bad --axis ${JSON.stringify(a)}; use wght=400 or wght=400:700`);
      const v: AxisSetting = m[3] === undefined ? Number(m[2]) : { min: Number(m[2]), max: Number(m[3]) };
      (opts.axes ??= {})[m[1]!] = v;
    }
    const src = new Uint8Array(readFileSync(file));
    const r = await subsetFont(src, opts);
    writeFileSync(o.output, r.woff2);
    const pct = ((1 - r.woff2.byteLength / src.byteLength) * 100).toFixed(1);
    process.stdout.write(`${o.output}: ${r.woff2.byteLength} bytes (${pct}% smaller than the source), ${r.unicodes.length} characters\nunicode-range: ${formatUnicodeRange(rangesFromCodePoints(r.unicodes))}\n`);
  });

/** Everything fontphobia writes goes in .fontphobia/, ignored except the manifest and sources/ (§9.9). */
function ensureOutDir(out: string, root: string) {
  if (resolve(out) === resolve(root, FONTPHOBIA_DIR)) ensureFontphobiaDir(root);
  else mkdirSync(out, { recursive: true });
}

const list = (v: unknown): string[] | undefined => {
  if (v === undefined || v === true) return undefined;
  return [v].flat().flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
};

interface AuditFlags {
  cwd?: string; dist?: string; buildCmd?: string; startCmd?: string; url?: string; pages?: string | string[]; ignore?: string | string[];
  viewports?: string; locales?: string; maxPages?: number; concurrency?: number; fontSizeSweep: boolean; cache: boolean; rebuild?: boolean; ci?: boolean; json?: boolean; outDir?: string;
}

async function runAudit(o: AuditFlags, how: { summary: boolean } = { summary: true }) {
  const root = resolve(o.cwd ?? '.');
  const { config, file } = await loadConfig(root, selfUrl());
  const quiet = !!o.json;
  const log = (m: string) => { if (!quiet) process.stderr.write(`  ${m}\n`); };
  if (file) log(`config: ${file}`);
  // Loaded on demand: inspect and subset don't need a browser.
  const { audit, since } = await import('@fontphobia/crawler');
  // Ask before crawling a stale build only when someone can answer; CI and --json just get the warning.
  const interactive = !quiet && !o.ci && !process.env.CI && process.stdin.isTTY && process.stderr.isTTY;
  const result = await audit({
    root, fontphobiaVersion: pkg.version, log,
    dist: o.dist ?? config.dist, url: o.url ?? config.url, buildCmd: o.buildCmd ?? config.build, startCmd: o.startCmd ?? config.start,
    rebuild: o.rebuild, pages: [...(config.pages ?? []), ...(list(o.pages) ?? [])], ignore: [...(config.ignore ?? []), ...(list(o.ignore) ?? [])],
    viewports: list(o.viewports)?.map(Number) ?? config.viewports, locales: list(o.locales) ?? config.locales,
    maxPages: o.maxPages ?? config.maxPages, concurrency: o.concurrency, fontSizeSweep: o.fontSizeSweep, cache: o.cache,
    storageState: config.auth?.storageState, privatePages: config.auth?.pages,
    onStale: interactive ? async (age) => {
      const n = age.newer!;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.on('SIGINT', () => { process.stderr.write('\n'); process.exit(130); });
      try {
        // Ctrl+D (end of input) takes the default.
        const a = await rl.question(`  ${age.output} was built ${since(age.builtAt)}; ${n.file}${n.count > 1 ? ` and ${n.count - 1} other file(s)` : ''} changed ${since(n.mtime)}. Rebuild first? (Y/n) `);
        return !/^n/i.test(a.trim());
      } catch { process.stderr.write('\n'); return true; } finally { rl.close(); }
    } : undefined,
  });
  const out = resolve(root, o.outDir ?? '.fontphobia');
  ensureOutDir(out, root);
  writeFileSync(join(out, 'usage.json'), canonicalJson(result.usage));
  writeFileSync(join(out, 'report.md'), auditMarkdown(result.usage as never, result.crawl));
  if (o.json) process.stdout.write(JSON.stringify({ crawl: result.crawl, usage: result.usage }, null, 2) + '\n');
  else if (how.summary) process.stdout.write('\n' + formatAudit(result.usage as never, result.crawl) + `\n\nWrote ${join(o.outDir ?? '.fontphobia', 'usage.json')} and report.md\n`);
  else log(`wrote ${join(o.outDir ?? '.fontphobia', 'usage.json')} and report.md`);
}

const auditCommand = (c: ReturnType<typeof cli.command>) => c
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--dist <dir>', 'Built site to crawl')
  .option('--build-cmd <cmd>', 'Command that builds the site (run when there is no output, it is stale and you agree, or with --rebuild)')
  .option('--start-cmd <cmd>', 'Command that starts the production server, for SSR routes')
  .option('--url <origin>', 'Crawl a running site instead')
  .option('--pages <paths>', 'Pages to add (paths), or globs to restrict to; repeatable')
  .option('--ignore <globs>', 'Pages to skip; repeatable')
  .option('--viewports <list>', 'Viewport widths (default 360,768,1280,1920)')
  .option('--locales <list>', 'Locales whose characters may render (e.g. en,fr,ro)')
  .option('--max-pages <n>', 'Stop discovering pages after n (default 500)')
  .option('--concurrency <n>', 'Parallel page visits')
  .option('--no-font-size-sweep', "Skip the browser default-font-size sweep")
  .option('--no-cache', 'Visit every page again, ignoring .fontphobia/cache/visits (by default a page is revisited only when something it loads changed)')
  .option('--rebuild', 'Build again even if output exists')
  .option('--ci', "Never prompt (also when CI is set); a stale build is crawled with a warning")
  .option('--out-dir <dir>', 'Where usage.json and report.md go (default .fontphobia)')
  .option('--json', 'Machine-readable output');

auditCommand(cli.command('audit', "Measure the fonts and each page's usage; writes .fontphobia/usage.json and report.md")).action(runAudit);

interface BuildFlags { cwd?: string; usage?: string; allow?: string | string[]; remainder: boolean; write?: boolean; u?: boolean; json?: boolean; ci?: boolean }

const selfUrl = () => new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.mjs', import.meta.url).href;

async function ask(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', () => { process.stderr.write('\n'); process.exit(130); });
  try { return /^y/i.test((await rl.question(q)).trim()); } catch { return false; } finally { rl.close(); }
}

async function runBuild(o: BuildFlags & { prompt?: boolean }) {
  const root = resolve(o.cwd ?? '.');
  const { config, file } = await loadConfig(root, selfUrl());
  const usageFile = resolve(root, o.usage ?? '.fontphobia/usage.json');
  if (!existsSync(usageFile)) throw new Error(`${usageFile} doesn't exist; run \`fontphobia audit\` first`);
  const usage = JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson;
  const log = (m: string) => { if (!o.json) process.stderr.write(`  ${m}\n`); };
  if (file) log(`config: ${file}`);
  log(`planning ${Object.keys(usage.faces).length} face(s)…`);
  const cfg = {
    coreThreshold: config.coreThreshold, remainder: o.remainder === false ? false : config.remainder,
    allow: [...(config.allow ?? []), ...(list(o.allow) ?? [])], locales: config.locales, rename: config.rename, licenses: config.licenses,
  };
  let write = !!(o.write || o.u);
  const r = await buildProject(root, usage, cfg, { version: pkg.version, write });
  if (o.json) { process.stdout.write(canonicalJson({ plan: r.plan, manifest: r.manifest, fonts: r.fonts, edits: r.edits, stale: r.stale, notWritten: r.notWritten, unchanged: r.unchanged, written: write })); return; }
  const out: string[] = [formatPlan(r.plan, usage), ''];
  const newFonts = r.fonts.filter((f) => !f.exists);
  if (r.unchanged) out.push('Nothing to change: the files on disk already match this plan.');
  else {
    const nEdit = new Set(r.edits.map((e) => e.file)).size;
    out.push(write
      ? `Wrote ${newFonts.length} font file(s), edited ${nEdit} file(s)${r.stale.length ? `, deleted ${r.stale.length} outdated output(s)` : ''} and wrote ${MANIFEST_FILE}:`
      : `Would write ${newFonts.length} font file(s), edit ${nEdit} file(s)${r.stale.length ? `, delete ${r.stale.length} outdated output(s)` : ''} and write ${MANIFEST_FILE}:`);
    for (const f of newFonts) out.push(`  ${f.file}  ${kb(f.bytes)}`);
    for (const g of r.generated.filter((x) => !x.exists)) out.push(`  ${g.file}  (generated stylesheet)`);
    for (const f of r.stale) out.push(`  - ${f}`);
    if (r.edits.length) out.push('', formatEdits(root, r.edits, 12, r.before));
    for (const g of r.manifest.google ?? []) {
      if (!r.edits.some((e) => e.why === `tighten ${g.to}` || e.text.replace(/&amp;/g, '&') === g.to)) continue;
      const d = [...g.dropped.families.map((f) => `${f} (no page uses it)`), ...Object.entries(g.dropped.weights).map(([f, w]) => `${f} ${w.join(', ')} (nothing asks for ${w.length > 1 ? 'these weights' : 'this weight'})`), ...Object.entries(g.dropped.axes).map(([f, a]) => `${f} ${a.join(', ')} axis (every use is at the default; limit-axes)`)];
      out.push('', `Google Fonts URL tightened (fonts still come from Google): drops ${d.join('; ')}.`);
    }
    for (const g of r.manifest.options ?? []) {
      if (!r.edits.some((e) => e.file === g.file && e.text === g.to)) continue;
      if (g.kind === 'preload') { out.push('', `${g.family} (<Font> in ${g.file}): preloads only the weights and styles pages load; the others stay declared and download when a page needs them. \`fontphobia verify\` compares against HEAD built in a git worktree.`); continue; }
      const d = [...(g.dropped.weights.length ? [`weight ${g.dropped.weights.join(', ')} (nothing asks for ${g.dropped.weights.length > 1 ? 'them' : 'it'}; tighten)`] : []), ...(g.dropped.axes.length ? [`axes ${g.dropped.axes.join(', ')} (every use is at the default; limit-axes)`] : [])];
      out.push('', `${g.family} (${g.adapter === 'astro-fonts' ? 'Astro fonts[]' : g.adapter === 'nuxt-fonts' ? 'nuxt.config fonts.families' : 'next/font/google'}, ${g.file}): drops ${d.join('; ')}. \`fontphobia verify\` compares against HEAD built in a git worktree.`);
    }
  }
  if (r.suggestions.length) {
    out.push('', 'Not applied: `--allow tighten` would also drop these. Nothing the crawled pages or the code asks for uses them, but a page the audit never saw (or CMS text) could, and would then render a nearby weight or a synthesized style:');
    for (const x of r.suggestions) {
      if (x.kind === 'google') {
        const what = [...x.families, ...Object.entries(x.weights).map(([f, w]) => `${f} ${w.join(', ')}`)].join('; ');
        out.push(`  Google Fonts ${x.sheet}: ${what}. Saves about ${kb(x.cssBytes)} of Google's CSS; fonts nothing uses never download, so font bytes don't change.`);
      } else out.push(`  ${x.family} (${x.adapter === 'astro-fonts' ? 'Astro fonts[]' : x.adapter === 'nuxt-fonts' ? 'nuxt.config fonts.families' : 'next/font/google'}, ${x.file}): weight ${x.weights.join(', ')}. ${x.adapter === 'next-font-google' ? 'Next downloads and preloads each listed weight of a static family' : 'Each listed weight is declared (and preloaded, if preloading is on)'}.`);
    }
  }
  if (r.snippets.length) {
    out.push('', `Paste these yourself (fontphobia can measure these faces but not edit where they're declared):`);
    for (const sn of r.snippets) out.push('', `  ${sn.id}${sn.file ? `, replacing the @font-face in ${sn.file}${sn.line ? `:${sn.line}` : ''}` : ''}:`, ...sn.css.split('\n').map((l) => `    ${l}`));
  }
  if (r.notWritten.length) { out.push('', 'Planned but not written'); for (const n of r.notWritten) out.push(`  ${n.id}: ${n.reason}`); }
  process.stdout.write(out.join('\n') + '\n');
  if (r.unchanged || write) { if (write && !o.prompt) process.stdout.write(`\nRun \`fontphobia verify\` to compare the site before and after. \`fontphobia revert\` puts the original declarations back.\n`); return { written: write, unchanged: r.unchanged }; }
  const interactive = o.prompt && !o.ci && !process.env.CI && process.stdin.isTTY && process.stderr.isTTY;
  if (interactive && await ask(`\nWrite ${newFonts.length} files and edit ${new Set(r.edits.map((e) => e.file)).size}? (y/N) `)) {
    write = true;
    await buildProject(root, usage, cfg, { version: pkg.version, write: true });
    process.stdout.write('Written. `fontphobia revert` undoes the edits.\n');
  } else if (!interactive) process.stdout.write('\nRun with --write to apply.\n');
  return { written: write, unchanged: false };
}

interface VerifyFlags {
  cwd?: string; usage?: string; dist?: string; buildCmd?: string; startCmd?: string; url?: string; rebuild?: boolean; pages?: string | string[];
  maxPages?: number; viewports?: string; dpr?: string; browsers?: string; hinting?: boolean; ignore?: string | string[]; mask?: string | string[]; timeout?: number; runtime?: string; baseline?: string; concurrency?: number; browser: boolean; json?: boolean; outDir?: string;
}

async function runVerify(o: VerifyFlags) {
  const root = resolve(o.cwd ?? '.');
  const { config } = await loadConfig(root, selfUrl());
  const usageFile = resolve(root, o.usage ?? join(o.outDir ?? '.fontphobia', 'usage.json'));
  if (!existsSync(usageFile)) throw new Error(`${usageFile} doesn't exist; run \`fontphobia audit\` first`);
  const usage = JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson;
  const log = (m: string) => { if (!o.json) process.stderr.write(`  ${m}\n`); };
  const { verify, formatVerify, verifyMarkdown, ENGINES } = await import('@fontphobia/crawler');
  const browsers = (list(o.browsers) ?? config.verify?.browsers ?? ['chromium']) as (typeof ENGINES)[number][];
  const bad = browsers.filter((b) => !ENGINES.includes(b));
  if (bad.length) throw new Error(`Unknown browser ${bad.join(', ')}; use ${ENGINES.join(', ')}`);
  if (o.baseline && !['overlay', 'worktree'].includes(o.baseline)) throw new Error(`Unknown --baseline ${o.baseline}; use overlay or worktree`);
  if (o.runtime && !['container', 'docker', 'podman'].includes(o.runtime)) throw new Error(`Unknown --runtime ${o.runtime}; use container, docker or podman`);
  const out = resolve(root, o.outDir ?? '.fontphobia');
  const r = await verify({
    root, usage, log, browser: o.browser,
    dist: o.dist ?? config.dist, url: o.url ?? config.url, buildCmd: o.buildCmd ?? config.build, startCmd: o.startCmd ?? config.start, rebuild: o.rebuild,
    pages: [...(config.pages ?? []), ...(list(o.pages) ?? [])], maxPages: o.maxPages ?? config.verify?.maxPages,
    ignore: [...(config.ignore ?? []), ...(list(o.ignore) ?? [])], mask: [...(config.verify?.mask ?? []), ...([o.mask].flat().filter((x): x is string => typeof x === 'string'))],
    timeout: o.timeout !== undefined ? Number(o.timeout) : config.verify?.timeout,
    viewports: list(o.viewports)?.map(Number) ?? config.verify?.viewports ?? config.viewports, dprs: list(o.dpr)?.map(Number) ?? config.verify?.dprs,
    browsers, hinting: o.hinting ?? config.verify?.hinting, runtime: o.runtime as 'container' | undefined, baseline: o.baseline as 'overlay' | undefined, concurrency: o.concurrency, outDir: join(out, 'verify'),
  });
  ensureOutDir(out, root);
  const reportFile = join(out, 'report.md');
  writeFileSync(reportFile, verifyMarkdown(existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '# fontphobia report\n', r, root));
  if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write('\n' + formatVerify(r, root) + `\nWrote the verify section of ${join(o.outDir ?? '.fontphobia', 'report.md')}\n`);
  if (!r.ok) process.exitCode = 1;
}

const verifyOptions = (c: ReturnType<typeof cli.command>) => c
  .option('--max-pages <n>', 'Pages to compare before a set cover picks a representative subset (default 200)')
  .option('--dpr <list>', 'Device pixel ratios (default 1,2)')
  .option('--browsers <list>', 'chromium (default), firefox, webkit (Playwright builds: `pnpm dlx playwright install webkit`), and linux-chromium, linux-firefox, linux-webkit (the pinned Playwright Linux image, in a container)')
  .option('--baseline <mode>', 'How "before" is made: overlay (default: this build with the original fonts swapped back) or worktree (HEAD built in a temporary git worktree)')
  .option('--hinting', 'Also run the worst case for rounding: Chrome in the pinned Linux image at DPR 1, hinting on')
  .option('--runtime <name>', 'Container runtime for linux-* and --hinting: container (Apple), docker or podman (default: the first that answers)')
  .option('--no-browser', 'Only the deterministic checks: font files, CSS and shaping (no Chrome)');

verifyOptions(cli
  .command('verify', 'Check the written fonts and compare every page before and after, in the browser')
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--usage <file>', 'usage.json from the audit (default .fontphobia/usage.json)')
  .option('--dist <dir>', 'Built site to serve')
  .option('--build-cmd <cmd>', 'Command that builds the site (run when the build is older than the sources)')
  .option('--start-cmd <cmd>', 'Command that starts the production server')
  .option('--url <origin>', 'Verify a running site instead')
  .option('--rebuild', 'Build again even if output exists')
  .option('--pages <paths>', 'Pages that are always compared; repeatable')
  .option('--ignore <globs>', 'Pages never compared; repeatable')
  .option('--mask <selector>', 'Hide these elements in both loads (script-driven animations, canvases, embeds); repeatable')
  .option('--timeout <seconds>', 'How long a page may take to load (default 30)')
  .option('--viewports <list>', 'Viewport widths (default: the audit\'s)')
  .option('--concurrency <n>', 'Parallel comparisons')
  .option('--out-dir <dir>', 'Where report.md and diff images go (default .fontphobia)')
  .option('--json', 'Machine-readable output'))
  .action((o: VerifyFlags) => runVerify(o));

const buildOptions = (c: ReturnType<typeof cli.command>) => c
  .option('--usage <file>', 'usage.json to plan from (default .fontphobia/usage.json)')
  .option('--allow <opt-in>', 'Enable an opt-in (limit-axes, drop-hinting, split-shaping, drop-hint-refs, self-host, tighten, eject); repeatable')
  .option('--no-remainder', 'No lazy "rest" file: unseen characters fall back to the system font')
  .option('--write, -u', 'Write the fonts, the CSS edits and .fontphobia/manifest.json without asking');

buildOptions(cli
  .command('build', 'Plan from .fontphobia/usage.json and write the subsets (no browser). Without --write it shows the plan and the diff')
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--ci', 'Never prompt')
  .option('--json', 'Machine-readable output'))
  .action((o: BuildFlags) => runBuild(o));

interface CheckFlags { cwd?: string; dist?: string; url?: string; usage?: string; allowChars?: string; mode?: string; strict?: boolean; json?: boolean; outDir?: string; viewports?: string; maxPages?: number }

async function runCheck(o: CheckFlags) {
  const root = resolve(o.cwd ?? '.');
  const { config } = await loadConfig(root, selfUrl());
  const mode = o.mode ?? config.check?.mode ?? 'error';
  if (mode !== 'warn' && mode !== 'error') throw new Error(`Unknown --mode ${mode}; use warn or error`);
  const usageFile = resolve(root, o.usage ?? join(o.outDir ?? '.fontphobia', 'usage.json'));
  const usage = existsSync(usageFile) ? (JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson) : undefined;
  let r;
  if (o.url) {
    // Exact mode: crawl production in Chrome and compare what it draws with the written files.
    const { audit } = await import('@fontphobia/crawler');
    const log = (m: string) => { if (!o.json) process.stderr.write(`  ${m}\n`); };
    const a = await audit({ root, url: o.url, fontphobiaVersion: pkg.version, log, cache: false, viewports: list(o.viewports)?.map(Number) ?? config.viewports, maxPages: o.maxPages ?? config.maxPages, locales: config.locales });
    r = await checkUsage(root, a.usage as unknown as UsageFileJson, { strict: o.strict ?? config.check?.strict });
  } else {
    r = await checkProject({ root, outputDir: o.dist ? resolve(root, o.dist) : config.dist ? resolve(root, config.dist) : undefined, usage, allowChars: o.allowChars ?? config.check?.allowChars, strict: o.strict ?? config.check?.strict });
  }
  process.stdout.write((o.json ? JSON.stringify(r, null, 2) : formatCheck(r)) + '\n');
  if (!r.ok && mode === 'error') process.exitCode = 1;
}

cli
  .command('check', 'Are the subsets up to date? Static by default (no browser; for postbuild and CI); --url crawls production')
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--dist <dir>', 'Built site whose text is checked (default: what the framework profile finds)')
  .option('--url <origin>', 'Exact mode: crawl this site in Chrome and compare what it draws')
  .option('--usage <file>', 'usage.json from the audit (default .fontphobia/usage.json)')
  .option('--allow-chars <chars>', 'Characters never reported (strings that never render)')
  .option('--mode <mode>', 'error (default: exit 1 when the site would render differently) or warn')
  .option('--strict', 'Also exit 1 when characters would load the rest file (renders correctly, downloads more)')
  .option('--viewports <list>', 'Viewport widths for --url')
  .option('--max-pages <n>', 'Page cap for --url')
  .option('--json', 'Machine-readable output')
  .action((o: CheckFlags) => runCheck(o));

cli
  .command('revert', 'Put the original @font-face declarations and preloads back from .fontphobia/manifest.json')
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--dry-run', 'Only show what would change')
  .option('--keep-kits', 'Leave Adobe kits changed by apply-kit as they are')
  .action(async (o: { cwd?: string; dryRun?: boolean; keepKits?: boolean }) => {
    const root = resolve(o.cwd ?? '.');
    // Adobe kits first (the API, with TYPEKIT_TOKEN); the files only once they're back.
    if (!o.dryRun) {
      const kp = await revertKits(root, (m) => process.stdout.write(m + '\n'), { keep: o.keepKits });
      if (kp.length) { process.stdout.write(`Problems (nothing else reverted):\n${kp.map((p) => `  ${p}`).join('\n')}\n`); process.exitCode = 1; return; }
    }
    const r = revertProject(root, { write: !o.dryRun });
    const L = [`${o.dryRun ? 'Would restore' : 'Restored'} ${r.files.length} file(s): ${r.files.join(', ') || 'none'}`];
    if (r.problems.length) { L.push('Problems (manifest kept):'); for (const p of r.problems) L.push(`  ${p}`); }
    if (r.removed.length) L.push(`${o.dryRun ? 'Would remove' : 'Removed'} generated stylesheet(s): ${r.removed.join(', ')}`);
    if (r.fonts.length) L.push(`Generated fonts left for you to delete:`, ...r.fonts.map((f) => `  ${f}`));
    process.stdout.write(L.join('\n') + '\n');
    if (r.problems.length) process.exitCode = 1;
  });

cli
  .command('apply-kit', 'Adobe Fonts: remove kit styles nothing uses (Typekit API; TYPEKIT_TOKEN)')
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--usage <file>', 'usage.json (default: .fontphobia/usage.json)')
  .option('--yes', 'Apply and publish without asking')
  .option('--check', 'Only check that the live kit serves every face and character the pages use')
  .action(async (o: { cwd?: string; usage?: string; yes?: boolean; check?: boolean }) => {
    const root = resolve(o.cwd ?? '.');
    const usage = readUsage(root, o.usage);
    if (!usage) throw new Error('No usage.json: run `fontphobia audit` first');
    const interactive = !process.env.CI && process.stdin.isTTY && process.stderr.isTTY;
    process.exitCode = await applyKit(root, usage, { yes: o.yes, check: o.check, ask, interactive: !!interactive, version: pkg.version, log: (m) => process.stdout.write(m + '\n') });
  });

// The default (§3): audit, plan, then ask before writing (like ncu). --write/-u skips the question.
verifyOptions(buildOptions(auditCommand(cli.command('', 'Audit the site, plan, write after you confirm (or with --write), then verify'))))
  .action(async (o: AuditFlags & BuildFlags & VerifyFlags) => {
    await runAudit({ ...o, json: false }, { summary: false });
    const b = await runBuild({ ...o, usage: o.outDir ? join(o.outDir, 'usage.json') : undefined, json: false, prompt: true });
    // Verify what was just written; the site is rebuilt first, since its sources changed.
    if (b?.written) { process.stderr.write('\n  verifying…\n'); await runVerify({ ...o, json: false, pages: undefined }); }
  });

cli.help();
cli.version(`${pkg.version} (HarfBuzz ${harfbuzzVersion()})`);

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (e) {
  process.stderr.write(`fontphobia: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
