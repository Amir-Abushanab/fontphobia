#!/usr/bin/env node
// fontphobia CLI: audit (M2), build and revert (M3–M4), verify (M5), check (M6).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { cac } from 'cac';
import {
  AUTO_OPT_INS,
  checkProject,
  checkUsage,
  formatCheck,
  ensureFontphobiaDir,
  FONTPHOBIA_DIR,
  auditMarkdown,
  buildProject,
  canonicalJson,
  formatAudit,
  formatAuto,
  formatEdits,
  formatPlan,
  kb,
  MANIFEST_FILE,
  revertProject,
  type UsageFileJson,
  formatInspection,
  formatUnicodeRange,
  harfbuzzVersion,
  inspectFont,
  parseUnicodeRange,
  rangesFromCodePoints,
  subsetFont,
  codePointsOf,
  type AxisSetting,
  type SubsetOptions,
  offeredOptIns,
  heavierPages,
  pageBytes,
  savedPct,
} from '@fontphobia/core';
import { loadConfig, selfUrl as selfUrlOf } from './config.ts';
import { applyKit, readUsage, revertKits } from './apply-kit.ts';
import { runAuto } from './auto-run.ts';
import { ansiStyle, colorEnabled, highlight, seconds, Ui } from './ui.ts';
import {
  compareVersions,
  latestVersion,
  needsReleaseDate,
  publishedAt,
  updateCheckEnabled,
  updateNotice,
} from './update.ts';
import type { Progress } from '@fontphobia/crawler';
import pkg from '../package.json' with { type: 'json' };

const cli = cac('fontphobia');

// cac turns numeric-looking values into numbers (`--text 2024`, `--name-ids 0`): string options are put back as strings.
const strs = <T extends object>(o: T, ...keys: (keyof T)[]): T => {
  for (const k of keys)
    if (o[k] !== undefined && o[k] !== true)
      (o as Record<keyof T, unknown>)[k] = Array.isArray(o[k]) ? (o[k] as unknown[]).map(String) : String(o[k]);
  return o;
};

/** The project root for --cwd: it must be an existing directory. */
function rootOf(cwd?: string): string {
  const root = resolve(cwd === undefined ? '.' : String(cwd));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  return root;
}

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
  .option(
    '--features <list>',
    '"default" (HarfBuzz defaults), "*", "+tnum,+ss01" (defaults plus these) or "kern,liga" (only these)',
    { default: 'default' },
  )
  .option('--name-ids <list>', 'name IDs to keep, or "*" (default 0-6,13,14,16,17,25)')
  .option(
    '--axis <tag=value>',
    'Pin an axis (wght=400) or limit it (wght=400:700). Changes widths slightly. Repeatable',
  )
  .option('--no-hinting', 'Drop TrueType hinting (changes rendering on Windows and Linux)')
  .action(
    async (
      file: string,
      o: {
        output?: string;
        unicodes?: string;
        text?: string;
        features: string;
        nameIds?: string;
        axis?: string | string[];
        hinting: boolean;
      },
    ) => {
      strs(o, 'output', 'unicodes', 'text', 'features', 'nameIds', 'axis');
      if (!o.output) throw new Error('--output is required');
      if (extname(o.output) !== '.woff2') throw new Error('--output must end in .woff2');
      const opts: SubsetOptions = { unicodes: '*', hinting: o.hinting };
      if (o.unicodes !== undefined || o.text !== undefined) {
        const cps = new Set<number>(o.unicodes !== undefined ? codePointsOf(parseUnicodeRange(o.unicodes)) : []);
        for (const ch of o.text ?? '') cps.add(ch.codePointAt(0)!);
        opts.unicodes = cps;
      }
      const f = o.features.trim();
      if (f === '*') opts.features = '*';
      else if (f !== 'default') {
        const tags = f
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        opts.features = tags.every((t) => t.startsWith('+')) ? { add: tags.map((t) => t.slice(1)) } : { only: tags };
      }
      if (o.nameIds !== undefined) opts.nameIds = o.nameIds === '*' ? '*' : o.nameIds.split(',').map(Number);
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
      process.stdout.write(
        `${o.output}: ${r.woff2.byteLength} bytes (${pct}% smaller than the source), ${r.unicodes.length} characters\nunicode-range: ${formatUnicodeRange(rangesFromCodePoints(r.unicodes))}\n`,
      );
    },
  );

/** Everything fontphobia writes goes in .fontphobia/, ignored except the manifest and sources/ (§9.9). */
function ensureOutDir(out: string, root: string) {
  if (resolve(out) === resolve(root, FONTPHOBIA_DIR)) ensureFontphobiaDir(root);
  else mkdirSync(out, { recursive: true });
}

const list = (v: unknown): string[] | undefined => {
  if (v === undefined || v === true) return undefined;
  return [v]
    .flat()
    .flatMap((x) => String(x).split(','))
    .map((x) => x.trim())
    .filter(Boolean);
};

interface AuditFlags {
  cwd?: string;
  dist?: string;
  buildCmd?: string;
  startCmd?: string;
  url?: string;
  pages?: string | string[];
  ignore?: string | string[];
  viewports?: string;
  locales?: string;
  maxPages?: number;
  concurrency?: number;
  fontSizeSweep: boolean;
  fullSweep?: boolean;
  cache: boolean;
  rebuild?: boolean;
  ci?: boolean;
  json?: boolean;
  outDir?: string;
  color?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each step does, shown under its heading. */
const EXPLAIN = {
  audit:
    'Loads every page in headless Chrome and records which characters, weights, features and axis values each web font draws. Each page is loaded at several viewport widths and browser default font sizes, because media queries and rem/em sizes can change which text shows.',
  plan: 'Splits each font into a core file (the characters the pages use), an extended file (more Latin and locale characters, loaded only by a page that uses one) and a rest file (everything else, so later content still renders). A unicode-range on each @font-face rule lets the browser pick the files. No browser is needed for this step.',
  write:
    'Subsets the fonts to WOFF2 with HarfBuzz and replaces the @font-face rules. The original rules are kept in .fontphobia/manifest.json, so `fontphobia revert` can put them back.',
  verify:
    'Checks that the new files decode and shape every recorded word exactly like the originals, then loads each page before and after in Chrome and compares layout and pixels.',
};

let updateChecked = false;
/** Ask the registry for the latest version in the background; say so when this one is older. */
function notifyUpdate(ui: Ui) {
  if (updateChecked || !updateCheckEnabled(process.env, ui.live)) return;
  updateChecked = true;
  const agent = process.env.npm_config_user_agent;
  void (async () => {
    const latest = await latestVersion();
    if (!latest || compareVersions(pkg.version, latest) >= 0) return;
    const released = needsReleaseDate(agent) ? await publishedAt(latest) : undefined;
    const n = updateNotice(pkg.version, latest, agent, released);
    if (n) ui.warn(n);
  })();
}

/** Progress events from the crawler, as the status line. */
const progressTo = (ui: Ui) =>
  ui.live
    ? (p: Progress) => {
        if (p.stage === 'build') ui.spin(p.done ? 'Starting Chrome' : `Building the site: ${p.item}`);
        else if (p.stage === 'discover') ui.progress('Finding pages', p.done, p.total, p.item);
        else if (p.stage === 'load') ui.progress('Loading pages', p.done, p.total, p.item);
        else ui.progress('Comparing pages', p.done, p.total, p.item);
      }
    : undefined;

async function runAudit(
  o: AuditFlags,
  how: { summary: boolean; ui?: Ui; step?: [number, number] } = { summary: true },
) {
  strs(o, 'cwd', 'dist', 'buildCmd', 'startCmd', 'url', 'pages', 'ignore', 'viewports', 'locales', 'outDir');
  const root = rootOf(o.cwd);
  const ui = how.ui ?? new Ui({ quiet: o.json, color: o.color, ci: o.ci });
  notifyUpdate(ui);
  const { config, file } = await loadConfig(root, selfUrl());
  ui.step(...(how.step ?? [0, 0]), 'Audit', EXPLAIN.audit);
  if (file) ui.log(`config: ${file}`);
  // Loaded on demand: inspect and subset don't need a browser.
  ui.spin('Starting Chrome');
  const { audit, since } = await import('@fontphobia/crawler');
  // Ask before crawling a stale build only when someone can answer; CI and --json just get the warning.
  const result = await audit({
    root,
    fontphobiaVersion: pkg.version,
    log: ui.log,
    progress: progressTo(ui),
    dist: o.dist ?? config.dist,
    url: o.url ?? config.url,
    buildCmd: o.buildCmd ?? config.build,
    startCmd: o.startCmd ?? config.start,
    rebuild: o.rebuild,
    pages: [...(config.pages ?? []), ...(list(o.pages) ?? [])],
    ignore: [...(config.ignore ?? []), ...(list(o.ignore) ?? [])],
    viewports: list(o.viewports)?.map(Number) ?? config.viewports,
    locales: list(o.locales) ?? config.locales,
    maxPages: o.maxPages ?? config.maxPages,
    concurrency: o.concurrency,
    fontSizeSweep: o.fontSizeSweep,
    fullSweep: o.fullSweep,
    cache: o.cache,
    storageState: config.auth?.storageState ? resolve(root, config.auth.storageState) : undefined,
    privatePages: config.auth?.pages,
    onStale: ui.interactive
      ? (age) => {
          const n = age.newer!;
          return ui.confirm(
            `${age.output} was built ${since(age.builtAt)}; ${n.file}${n.count > 1 ? ` and ${n.count - 1} other file(s)` : ''} changed ${since(n.mtime)}. Rebuild first?`,
            true,
          );
        }
      : undefined,
  });
  ui.stop();
  const out = resolve(root, o.outDir ?? '.fontphobia');
  ensureOutDir(out, root);
  writeFileSync(join(out, 'usage.json'), canonicalJson(result.usage));
  writeFileSync(join(out, 'report.md'), auditMarkdown(result.usage as never, result.crawl));
  if (o.json) {
    process.stdout.write(JSON.stringify({ crawl: result.crawl, usage: result.usage }, null, 2) + '\n');
    return;
  }
  const c = result.crawl;
  const nFailed = Object.keys(c.failed).length;
  ui.ok(`${plural(c.pages.length, 'page')} found${nFailed ? `; ${nFailed} load(s) failed (listed in report.md)` : ''}`);
  const sizes = c.fontSizes.filter((x) => x !== 16);
  const settings = `${plural(c.viewports.length, 'viewport width')} (${c.viewports.join(', ')} px)${sizes.length ? `, then the browser's default font size set to ${sizes.join(' and ')} px` : ''}`;
  const reused = c.cache?.reused ? `; ${c.cache.reused} reused from the cache, since nothing they load changed` : '';
  if (c.sweep)
    ui.ok(
      `${plural(c.visits, 'page load')}: every page at ${c.viewports.includes(1280) ? 1280 : c.viewports.at(-1)} px; ${settings} on ${c.sweep.sampled} sample page(s), up to ${c.sweep.perSection} per section (${c.sweep.sections} sections), and on the other pages only where a sample page drew text its first load didn't (${c.sweep.skipped} loads skipped; --full-sweep runs them)${reused}`,
    );
  else {
    const per = c.pages.length && c.visits % c.pages.length === 0 ? ` (${c.visits / c.pages.length} per page)` : '';
    ui.ok(`${plural(c.visits, 'page load')}${per}: ${settings}${reused}`);
  }
  const families = [...new Set(Object.values(result.usage.faces).map((f) => f.family))];
  ui.ok(
    families.length
      ? `${plural(Object.keys(result.usage.faces).length, 'font face')} drawn (${families.join(', ')})`
      : 'No web fonts are drawn',
  );
  const where = join(o.outDir ?? '.fontphobia', 'usage.json');
  if (how.summary)
    ui.print(
      '\n' + highlight(formatAudit(result.usage as never, result.crawl), ui.out) + `\n\nWrote ${where} and report.md\n`,
    );
  else ui.ok(`Wrote ${where} and report.md ${ui.err.dim(`(${seconds(c.durationMs)})`)}`);
}

const auditCommand = (c: ReturnType<typeof cli.command>) =>
  c
    .option('--cwd <dir>', 'Project root (default: current directory)')
    .option('--dist <dir>', 'Built site to crawl')
    .option(
      '--build-cmd <cmd>',
      'Command that builds the site (run when there is no output, it is stale and you agree, or with --rebuild)',
    )
    .option('--start-cmd <cmd>', 'Command that starts the production server, for SSR routes')
    .option('--url <origin>', 'Crawl a running site instead')
    .option('--pages <paths>', 'Pages to add (paths), or globs to restrict to; repeatable')
    .option('--ignore <globs>', 'Pages to skip; repeatable')
    .option('--viewports <list>', 'Viewport widths (default 360,768,1280,1920)')
    .option('--locales <list>', 'Locales whose characters may render (e.g. en,fr,ro)')
    .option('--max-pages <n>', 'Stop discovering pages after n (default 500)')
    .option('--concurrency <n>', 'Parallel page visits')
    .option('--no-font-size-sweep', 'Skip the browser default-font-size sweep')
    .option(
      '--full-sweep',
      'Every width and font size on every page (default: on 2 sample pages per section, and on the others where a sample drew something new)',
    )
    .option(
      '--no-cache',
      'Visit every page again, ignoring .fontphobia/cache/visits (by default a page is revisited only when something it loads changed)',
    )
    .option('--rebuild', 'Build again even if output exists')
    .option('--ci', 'Never prompt (also when CI is set); a stale build is crawled with a warning')
    .option('--out-dir <dir>', 'Where usage.json and report.md go (default .fontphobia)')
    .option('--json', 'Machine-readable output');

auditCommand(
  cli.command('audit', "Measure the fonts and each page's usage; writes .fontphobia/usage.json and report.md"),
).action(runAudit);

interface BuildFlags {
  cwd?: string;
  usage?: string;
  allow?: string | string[];
  coreThreshold?: string | number;
  remainder: boolean;
  write?: boolean;
  u?: boolean;
  json?: boolean;
  ci?: boolean;
  color?: boolean;
}

const selfUrl = () => selfUrlOf(import.meta.url);

/** --core-threshold: 'auto', or the share of a face's pages (0 to 1) a character needs to be in core. */
function coreThresholdOf(v: unknown): number | 'auto' | undefined {
  if (v === undefined) return undefined;
  if (v === 'auto') return v;
  if (typeof v !== 'number' || !(v >= 0 && v <= 1))
    throw new Error("--core-threshold must be 'auto' or a number between 0 and 1");
  return v;
}

/** Median font bytes per page, now and with the plan applied. */
function medianPage(r: Awaited<ReturnType<typeof buildProject>>, usage: UsageFileJson) {
  const ps = pageBytes(r.plan, usage);
  const med = (xs: number[]) => xs.toSorted((x, y) => x - y)[Math.floor((xs.length - 1) / 2)] ?? 0;
  return { now: med(ps.map((p) => p.now)), after: med(ps.map((p) => p.after)) };
}

/** "styles.css" or "styles.css, index.html and 3 more". */
const fileList = (files: string[]) =>
  files.length <= 3
    ? files.join(files.length === 2 ? ' and ' : ', ')
    : `${files.slice(0, 2).join(', ')} and ${files.length - 2} more`;

/** What runBuild did, for the default command's summary. */
interface BuildOutcome {
  written: boolean;
  unchanged: boolean;
  now: number;
  after: number;
  /** Opt-ins picked in the prompt. */
  applied: string[];
}

async function runBuild(
  o: BuildFlags & { prompt?: boolean },
  how: { ui?: Ui; step?: [number, number] } = {},
): Promise<BuildOutcome | undefined> {
  strs(o, 'cwd', 'usage', 'allow');
  const root = rootOf(o.cwd);
  const ui = how.ui ?? new Ui({ quiet: o.json, color: o.color, ci: o.ci });
  const { config, file } = await loadConfig(root, selfUrl());
  const usageFile = resolve(root, o.usage ?? '.fontphobia/usage.json');
  if (!existsSync(usageFile)) throw new Error(`${usageFile} doesn't exist; run \`fontphobia audit\` first`);
  const usage = JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson;
  ui.step(...(how.step ?? [0, 0]), 'Plan', EXPLAIN.plan);
  if (file && !how.ui) ui.log(`config: ${file}`);
  const cfg = {
    coreThreshold: coreThresholdOf(o.coreThreshold) ?? config.coreThreshold,
    remainder: o.remainder === false ? false : config.remainder,
    allow: [...(config.allow ?? []), ...(list(o.allow) ?? [])],
    locales: config.locales,
    rename: config.rename,
    licenses: config.licenses,
  };
  const autoOnly = cfg.allow.filter((a) => (AUTO_OPT_INS as readonly string[]).includes(a));
  if (autoOnly.length) ui.log(`${autoOnly.join(', ')}: not applied by \`build\`; \`fontphobia auto\` applies them`);
  let write = !!(o.write || o.u);
  ui.spin(`Planning ${plural(Object.keys(usage.faces).length, 'face')} and subsetting with HarfBuzz`);
  let r = await buildProject(root, usage, cfg, { version: pkg.version, write });
  ui.stop();
  if (o.json) {
    process.stdout.write(
      canonicalJson({
        plan: r.plan,
        manifest: r.manifest,
        fonts: r.fonts,
        edits: r.edits,
        stale: r.stale,
        notWritten: r.notWritten,
        unchanged: r.unchanged,
        written: write,
        // Pages that would download more font bytes than before fontphobia (bytes), the worst first.
        heavier: heavierPages(pageBytes(r.plan, usage)).map((p) => ({ page: p.page, before: p.now, after: p.after })),
      }),
    );
    return;
  }
  const s = ui.out;
  const applied: string[] = [];
  // Offer the opt-ins as a choice when someone can answer and didn't already choose with --allow.
  const offered = offeredOptIns(r.plan);
  const pick =
    !!o.prompt &&
    ui.interactive &&
    !write &&
    !r.unchanged &&
    !list(o.allow)?.length &&
    (offered.length > 0 || r.suggestions.length > 0);
  ui.print(formatPlan(r.plan, usage, { style: s, optIns: !pick }) + '\n');
  if (pick) {
    const w = Math.max(...offered.map((x) => x.id.length), r.suggestions.length ? 'tighten'.length : 0);
    const choices = [
      ...offered.map((x) => ({
        value: x.id,
        label: x.id.padEnd(w),
        hint: `saves ${kb(x.saving).padStart(8)}${x.faces > 1 ? ` across ${x.faces} faces` : ''}`,
        detail: `${x.id}: ${x.change}.`,
      })),
      ...(r.suggestions.length && !cfg.allow.includes('tighten')
        ? [
            {
              value: 'tighten',
              label: 'tighten'.padEnd(w),
              hint: `drops ${r.suggestions.length === 1 ? 'a weight or family' : 'weights or families'} nothing asks for`,
              detail:
                "tighten: drops weights and families that nothing on the crawled pages or in the code asks for. A page the audit didn't see (or CMS text) could ask for one and would then render a nearby weight or a synthesized style.",
            },
          ]
        : []),
    ];
    process.stderr.write('\n');
    ui.note(
      'Opt-ins save more bytes but change how text renders, so none is applied by default. The line under the cursor says what it changes. `verify` reports those changes as differences and exits 1, so a CI job that runs `verify` fails.',
      '',
    );
    const picks = await ui.multiselect('Apply any opt-ins?', choices);
    if (picks.length) {
      const was = medianPage(r, usage);
      cfg.allow = [...cfg.allow, ...picks];
      ui.spin('Planning again with the opt-ins');
      r = await buildProject(root, usage, cfg, { version: pkg.version, write: false });
      ui.stop();
      const m = medianPage(r, usage);
      ui.ok(
        `With ${picks.join(', ')}: median font bytes per page ${kb(m.now)} → ${ui.err.bold(kb(m.after))} (${ui.err.green(`${savedPct(m.now, m.after)} less`)}), ${kb(Math.max(0, was.after - m.after))} less than without`,
      );
      applied.push(...picks);
      ui.note(`Next time: \`--allow ${picks.join(',')}\`, or \`allow\` in the config.`, '    ');
    }
  }
  const out: string[] = [];
  const newFonts = r.fonts.filter((f) => !f.exists);
  const edited = [...new Set(r.edits.map((e) => e.file))];
  if (r.unchanged) out.push('', s.green('Nothing to change: the files on disk already match this plan.'));
  else {
    out.push(
      '',
      s.bold(
        write
          ? `Wrote ${plural(newFonts.length, 'font file')}, edited ${plural(edited.length, 'file')}${r.stale.length ? `, deleted ${r.stale.length} outdated output(s)` : ''} and wrote ${MANIFEST_FILE}:`
          : `Would write ${plural(newFonts.length, 'font file')}, edit ${plural(edited.length, 'file')}${r.stale.length ? `, delete ${r.stale.length} outdated output(s)` : ''} and write ${MANIFEST_FILE}:`,
      ),
    );
    const width = Math.max(0, ...newFonts.map((f) => f.file.length));
    for (const f of newFonts) out.push(`  ${s.green('+')} ${f.file.padEnd(width)}  ${kb(f.bytes).padStart(9)}`);
    for (const g of r.generated.filter((x) => !x.exists))
      out.push(`  ${s.green('+')} ${g.file}  ${s.dim('(generated stylesheet)')}`);
    for (const f of r.stale) out.push(`  ${s.red('-')} ${f}  ${s.dim('(outdated output)')}`);
    if (r.edits.length) {
      const cols = (process.stdout.isTTY && process.stdout.columns) || 120;
      out.push('', formatEdits(root, r.edits, 40, r.before, { style: s, width: Math.max(60, cols - 4) }));
    }
    for (const g of r.manifest.google ?? []) {
      if (!r.edits.some((e) => e.why === `tighten ${g.to}` || e.text.replace(/&amp;/g, '&') === g.to)) continue;
      const d = [
        ...g.dropped.families.map((f) => `${f} (no page uses it)`),
        ...Object.entries(g.dropped.weights).map(
          ([f, w]) => `${f} ${w.join(', ')} (nothing asks for ${w.length > 1 ? 'these weights' : 'this weight'})`,
        ),
        ...Object.entries(g.dropped.axes).map(
          ([f, a]) => `${f} ${a.join(', ')} axis (every use is at the default; limit-axes)`,
        ),
      ];
      out.push('', `Google Fonts URL tightened (fonts still come from Google): drops ${d.join('; ')}.`);
    }
    for (const g of r.manifest.options ?? []) {
      if (!r.edits.some((e) => e.file === g.file && e.text === g.to)) continue;
      if (g.kind === 'preload') {
        out.push(
          '',
          `${g.family} (<Font> in ${g.file}): preloads only the weights and styles pages load; the others stay declared and download when a page needs them. \`fontphobia verify\` compares against HEAD built in a git worktree.`,
        );
        continue;
      }
      const d = [
        ...(g.dropped.weights.length
          ? [
              `weight ${g.dropped.weights.join(', ')} (nothing asks for ${g.dropped.weights.length > 1 ? 'them' : 'it'}; tighten)`,
            ]
          : []),
        ...(g.dropped.axes.length
          ? [`axes ${g.dropped.axes.join(', ')} (every use is at the default; limit-axes)`]
          : []),
      ];
      out.push(
        '',
        `${g.family} (${g.adapter === 'astro-fonts' ? 'Astro fonts[]' : g.adapter === 'nuxt-fonts' ? 'nuxt.config fonts.families' : 'next/font/google'}, ${g.file}): drops ${d.join('; ')}. \`fontphobia verify\` compares against HEAD built in a git worktree.`,
      );
    }
  }
  if (r.suggestions.length && !pick) {
    out.push(
      '',
      'Not applied: `--allow tighten` would also drop these. Nothing the crawled pages or the code asks for uses them, but a page the audit never saw (or CMS text) could, and would then render a nearby weight or a synthesized style:',
    );
    for (const x of r.suggestions) {
      if (x.kind === 'google') {
        const what = [...x.families, ...Object.entries(x.weights).map(([f, w]) => `${f} ${w.join(', ')}`)].join('; ');
        out.push(
          `  Google Fonts ${x.sheet}: ${what}. Saves about ${kb(x.cssBytes)} of Google's CSS; fonts nothing uses never download, so font bytes don't change.`,
        );
      } else
        out.push(
          `  ${x.family} (${x.adapter === 'astro-fonts' ? 'Astro fonts[]' : x.adapter === 'nuxt-fonts' ? 'nuxt.config fonts.families' : 'next/font/google'}, ${x.file}): weight ${x.weights.join(', ')}. ${x.adapter === 'next-font-google' ? 'Next downloads and preloads each listed weight of a static family' : 'Each listed weight is declared (and preloaded, if preloading is on)'}.`,
        );
    }
  }
  if (r.snippets.length) {
    out.push('', `Paste these yourself (fontphobia can measure these faces but not edit where they're declared):`);
    for (const sn of r.snippets)
      out.push(
        '',
        `  ${sn.id}${sn.file ? `, replacing the @font-face in ${sn.file}${sn.line ? `:${sn.line}` : ''}` : ''}:`,
        ...sn.css.split('\n').map((l) => `    ${l}`),
      );
  }
  if (r.notWritten.length) {
    out.push('', 'Planned but not written');
    for (const n of r.notWritten) out.push(`  ${n.id}: ${n.reason}`);
  }
  ui.print(out.join('\n') + '\n');
  const m = medianPage(r, usage);
  if (r.unchanged || write) {
    if (write && !o.prompt)
      ui.print(
        `\nRun \`fontphobia verify\` to compare the site before and after. \`fontphobia revert\` puts the original declarations back.\n`,
      );
    return { written: write, unchanged: r.unchanged, ...m, applied };
  }
  if (o.prompt && ui.interactive) {
    process.stderr.write('\n');
    ui.note(EXPLAIN.write, '');
    if (await ui.confirm(`Write ${plural(newFonts.length, 'font file')} and edit ${fileList(edited)}?`)) {
      write = true;
      ui.spin('Writing');
      await buildProject(root, usage, cfg, { version: pkg.version, write: true });
      ui.stop();
      ui.ok(
        `Wrote ${plural(newFonts.length, 'font file')} (${kb(newFonts.reduce((n, f) => n + f.bytes, 0))}), edited ${fileList(edited)} and wrote ${MANIFEST_FILE}`,
      );
      ui.note('`fontphobia revert` puts the original rules back.', '    ');
    } else ui.note('Nothing written. `fontphobia --write` applies this plan without asking.', '  ');
  } else ui.print(`\nRun with --write to apply${offered.length ? ', and --allow <name> to add an opt-in' : ''}.\n`);
  return { written: write, unchanged: false, ...m, applied };
}

interface VerifyFlags {
  cwd?: string;
  usage?: string;
  dist?: string;
  buildCmd?: string;
  startCmd?: string;
  url?: string;
  rebuild?: boolean;
  /** Accepted and unused: verify never prompts. */ ci?: boolean;
  pages?: string | string[];
  maxPages?: number;
  allPages?: boolean;
  asLoaded?: boolean;
  viewports?: string;
  dpr?: string;
  browsers?: string;
  hinting?: boolean;
  ignore?: string | string[];
  mask?: string | string[];
  timeout?: number;
  runtime?: string;
  baseline?: string;
  concurrency?: number;
  browser: boolean;
  json?: boolean;
  outDir?: string;
  color?: boolean;
}

async function runVerify(o: VerifyFlags, how: { ui?: Ui; step?: [number, number] } = {}) {
  strs(
    o,
    'cwd',
    'usage',
    'dist',
    'buildCmd',
    'startCmd',
    'url',
    'pages',
    'ignore',
    'mask',
    'viewports',
    'dpr',
    'browsers',
    'outDir',
    'runtime',
    'baseline',
  );
  const root = rootOf(o.cwd);
  const { config } = await loadConfig(root, selfUrl());
  const usageFile = resolve(root, o.usage ?? join(o.outDir ?? '.fontphobia', 'usage.json'));
  if (!existsSync(usageFile)) throw new Error(`${usageFile} doesn't exist; run \`fontphobia audit\` first`);
  const usage = JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson;
  const ui = how.ui ?? new Ui({ quiet: o.json, color: o.color });
  notifyUpdate(ui);
  ui.step(
    ...(how.step ?? [0, 0]),
    'Verify',
    o.browser === false ? EXPLAIN.verify.replace(/, then loads.*$/, '.') : EXPLAIN.verify,
  );
  const log = ui.log;
  const { verify, formatVerify, verifyMarkdown, ENGINES } = await import('@fontphobia/crawler');
  const browsers = (list(o.browsers) ?? config.verify?.browsers ?? ['chromium']) as (typeof ENGINES)[number][];
  const bad = browsers.filter((b) => !ENGINES.includes(b));
  if (bad.length) throw new Error(`Unknown browser ${bad.join(', ')}; use ${ENGINES.join(', ')}`);
  if (o.baseline && !['overlay', 'worktree'].includes(o.baseline))
    throw new Error(`Unknown --baseline ${o.baseline}; use overlay or worktree`);
  if (o.runtime && !['container', 'docker', 'podman'].includes(o.runtime))
    throw new Error(`Unknown --runtime ${o.runtime}; use container, docker or podman`);
  const out = resolve(root, o.outDir ?? '.fontphobia');
  ui.spin('Verifying');
  const r = await verify({
    root,
    usage,
    log,
    progress: progressTo(ui),
    browser: o.browser,
    dist: o.dist ?? config.dist,
    url: o.url ?? config.url,
    buildCmd: o.buildCmd ?? config.build,
    startCmd: o.startCmd ?? config.start,
    rebuild: o.rebuild,
    pages: [...(config.pages ?? []), ...(list(o.pages) ?? [])],
    maxPages: o.maxPages ?? config.verify?.maxPages,
    allPages: o.allPages,
    asLoaded: o.asLoaded,
    ignore: [...(config.ignore ?? []), ...(list(o.ignore) ?? [])],
    mask: [...(config.verify?.mask ?? []), ...[o.mask].flat().filter((x): x is string => typeof x === 'string')],
    timeout: o.timeout !== undefined ? Number(o.timeout) : config.verify?.timeout,
    viewports: list(o.viewports)?.map(Number) ?? config.verify?.viewports ?? config.viewports,
    dprs: list(o.dpr)?.map(Number) ?? config.verify?.dprs,
    browsers,
    hinting: o.hinting ?? config.verify?.hinting,
    runtime: o.runtime as 'container' | undefined,
    baseline: o.baseline as 'overlay' | undefined,
    concurrency: o.concurrency,
    outDir: join(out, 'verify'),
  });
  ui.stop();
  ensureOutDir(out, root);
  const reportFile = join(out, 'report.md');
  writeFileSync(
    reportFile,
    verifyMarkdown(existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '# fontphobia report\n', r, root),
  );
  if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else
    ui.print(
      '\n' +
        highlight(formatVerify(r, root), ui.out) +
        `\nWrote the verify section of ${join(o.outDir ?? '.fontphobia', 'report.md')}\n`,
    );
  if (!r.ok) process.exitCode = 1;
  return r;
}

const verifyOptions = (c: ReturnType<typeof cli.command>) =>
  c
    .option('--max-pages <n>', 'Most pages to compare (default 200)')
    .option(
      '--as-loaded',
      'Also screenshot each page as it loaded, before a fresh paint, and report what the repaint changed (one more full-page screenshot per load)',
    )
    .option(
      '--all-pages',
      'Compare every page (default: 2 per section, plus pages so every face is compared with each of its files and character classes)',
    )
    .option('--dpr <list>', 'Device pixel ratios (default 1,2)')
    .option(
      '--browsers <list>',
      'chromium (default), firefox, webkit (Playwright builds: `pnpm dlx playwright install webkit`), and linux-chromium, linux-firefox, linux-webkit (the pinned Playwright Linux image, in a container)',
    )
    .option(
      '--baseline <mode>',
      'How "before" is made: overlay (default: this build with the original fonts swapped back) or worktree (HEAD built in a temporary git worktree)',
    )
    .option('--hinting', 'Also run the worst case for rounding: Chrome in the pinned Linux image at DPR 1, hinting on')
    .option(
      '--runtime <name>',
      'Container runtime for linux-* and --hinting: container (Apple), docker or podman (default: the first that answers)',
    )
    .option('--no-browser', 'Only the deterministic checks: font files, CSS and shaping (no Chrome)');

verifyOptions(
  cli
    .command('verify', 'Check the written fonts and compare every page before and after, in the browser')
    .option('--cwd <dir>', 'Project root (default: current directory)')
    .option('--ci', 'Accepted so a CI script can pass it to every command (verify never prompts)')
    .option('--usage <file>', 'usage.json from the audit (default .fontphobia/usage.json)')
    .option('--dist <dir>', 'Built site to serve')
    .option('--build-cmd <cmd>', 'Command that builds the site (run when the build is older than the sources)')
    .option('--start-cmd <cmd>', 'Command that starts the production server')
    .option('--url <origin>', 'Verify a running site instead')
    .option('--rebuild', 'Build again even if output exists')
    .option('--pages <paths>', 'Pages that are always compared; repeatable')
    .option('--ignore <globs>', 'Pages never compared; repeatable')
    .option(
      '--mask <selector>',
      'Hide these elements in both loads (script-driven animations, canvases, embeds); repeatable',
    )
    .option('--timeout <seconds>', 'How long a page may take to load (default 30)')
    .option('--viewports <list>', "Viewport widths (default: the audit's)")
    .option('--concurrency <n>', 'Parallel comparisons')
    .option('--out-dir <dir>', 'Where report.md and diff images go (default .fontphobia)')
    .option('--json', 'Machine-readable output'),
).action((o: VerifyFlags) => runVerify(o));

const buildOptions = (c: ReturnType<typeof cli.command>) =>
  c
    .option('--usage <file>', 'usage.json to plan from (default .fontphobia/usage.json)')
    .option(
      '--allow <opt-in>',
      'Enable an opt-in (limit-axes, drop-hinting, split-shaping, drop-hint-refs, self-host, tighten, eject); repeatable',
    )
    .option(
      '--core-threshold <auto|share>',
      "Which used characters go in core: 'auto' measures (default), 0 to 1 is a fixed share of a face's pages",
    )
    .option('--no-remainder', 'No lazy "rest" file: unseen characters fall back to the system font')
    .option('--write, -u', 'Write the fonts, the CSS edits and .fontphobia/manifest.json without asking');

buildOptions(
  cli
    .command(
      'build',
      'Plan from .fontphobia/usage.json and write the subsets (no browser). Without --write it shows the plan and the diff',
    )
    .option('--cwd <dir>', 'Project root (default: current directory)')
    .option('--ci', 'Never prompt')
    .option('--json', 'Machine-readable output'),
).action((o: BuildFlags) => runBuild(o));

interface CheckFlags {
  cwd?: string;
  /** Accepted and unused: check never prompts. */ ci?: boolean;
  dist?: string;
  url?: string;
  usage?: string;
  allowChars?: string;
  mode?: string;
  strict?: boolean;
  json?: boolean;
  outDir?: string;
  viewports?: string;
  maxPages?: number;
  color?: boolean;
}

async function runCheck(o: CheckFlags) {
  strs(o, 'cwd', 'dist', 'url', 'usage', 'allowChars', 'mode', 'outDir', 'viewports');
  const root = rootOf(o.cwd);
  const { config } = await loadConfig(root, selfUrl());
  const mode = o.mode ?? config.check?.mode ?? 'error';
  if (mode !== 'warn' && mode !== 'error') throw new Error(`Unknown --mode ${mode}; use warn or error`);
  const usageFile = resolve(root, o.usage ?? join(o.outDir ?? '.fontphobia', 'usage.json'));
  const usage = existsSync(usageFile) ? (JSON.parse(readFileSync(usageFile, 'utf8')) as UsageFileJson) : undefined;
  const ui = new Ui({ quiet: o.json, color: o.color });
  let r;
  let failed: Record<string, string> = {};
  if (o.url) {
    // Exact mode: crawl production in Chrome and compare what it draws with the written files.
    const { audit } = await import('@fontphobia/crawler');
    const a = await audit({
      root,
      url: o.url,
      fontphobiaVersion: pkg.version,
      log: ui.log,
      progress: progressTo(ui),
      cache: false,
      viewports: list(o.viewports)?.map(Number) ?? config.viewports,
      maxPages: o.maxPages ?? config.maxPages,
      locales: config.locales,
      pages: config.pages,
      ignore: config.ignore,
      storageState: config.auth?.storageState ? resolve(root, config.auth.storageState) : undefined,
      privatePages: config.auth?.pages,
    });
    ui.stop();
    failed = a.crawl.failed;
    r = await checkUsage(root, a.usage as unknown as UsageFileJson, { strict: o.strict ?? config.check?.strict });
  } else {
    r = await checkProject({
      root,
      outputDir: o.dist ? resolve(root, o.dist) : config.dist ? resolve(root, config.dist) : undefined,
      usage,
      allowChars: o.allowChars ?? config.check?.allowChars,
      strict: o.strict ?? config.check?.strict,
    });
  }
  const nFailed = Object.keys(failed).length;
  if (o.json) process.stdout.write(JSON.stringify(nFailed ? { ...r, failed } : r, null, 2) + '\n');
  else {
    ui.print(highlight(formatCheck(r), ui.out) + '\n');
    if (nFailed)
      process.stdout.write(
        `${nFailed} page(s) could not be loaded:\n${Object.entries(failed)
          .slice(0, 10)
          .map(([p, e]) => `  ${p}: ${e}`)
          .join('\n')}${nFailed > 10 ? `\n  … and ${nFailed - 10} more` : ''}\n`,
      );
  }
  // Nothing checked (no manifest, pages that didn't load) is a failure unless the mode is warn.
  if ((!r.ok || r.noManifest || nFailed) && mode === 'error') process.exitCode = 1;
}

cli
  .command(
    'check',
    'Are the subsets up to date? Static by default (no browser; for postbuild and CI); --url crawls production',
  )
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--ci', 'Accepted so a CI script can pass it to every command (check never prompts)')
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
  .command(
    'auto',
    'Subset the fonts of the built site in its output directory (no source edits, nothing to commit). Run it after every build',
  )
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--dist <dir>', 'The built site (default: what the framework profile finds)')
  .option('--crawl', 'Measure each face in Chrome (default: read the built text; no browser)')
  .option(
    '--rules <where>',
    'Where the split rules go: inline (default, in each page) or linked (one cached stylesheet)',
  )
  .option(
    '--allow <opt-in>',
    'Enable an opt-in (drop-hinting, split-shaping, drop-hint-refs; with --crawl, add-preloads and prefetch-extended; with --rules linked, inline-core); repeatable',
  )
  .option(
    '--core-threshold <auto|share>',
    "Which used characters go in core: 'auto' measures (default), 0 to 1 is a fixed share of a face's pages",
  )
  .option('--no-remainder', 'No lazy "rest" file')
  .option('--dry-run', 'Plan and report; write nothing')
  .option('--verify', 'Also compare every page before and after in Chrome (the browser stage of `verify`)')
  .option('--json', 'Machine-readable output')
  .action(
    async (o: {
      cwd?: string;
      dist?: string;
      crawl?: boolean;
      rules?: string;
      verify?: boolean;
      allow?: string | string[];
      coreThreshold?: string | number;
      remainder: boolean;
      dryRun?: boolean;
      json?: boolean;
      color?: boolean;
    }) => {
      strs(o, 'cwd', 'dist', 'allow', 'rules');
      const ui = new Ui({ quiet: o.json, color: o.color });
      notifyUpdate(ui);
      if (o.rules !== undefined && o.rules !== 'inline' && o.rules !== 'linked')
        throw new Error('--rules takes inline or linked');
      const root = rootOf(o.cwd);
      const { result, outDir, failed, verify } = await runAuto({
        root,
        outDir: o.dist,
        crawl: o.crawl,
        rules: o.rules,
        verify: o.verify,
        write: !o.dryRun,
        allow: list(o.allow),
        coreThreshold: coreThresholdOf(o.coreThreshold),
        remainder: o.remainder,
        log: ui.log,
        progress: progressTo(ui),
      });
      ui.stop();
      const nFailed = Object.keys(failed).length;
      if (verify && !verify.ok) process.exitCode = 1;
      if (o.json) {
        // The usage and the in-memory manifest are verify's input, not part of the report.
        const { usage: _usage, manifest: _manifest, ...report } = result;
        process.stdout.write(
          JSON.stringify({ ...report, ...(nFailed ? { failed } : {}), ...(verify ? { verify } : {}) }, null, 2) + '\n',
        );
        return;
      }
      ui.print(highlight(formatAuto(result, relative(root, outDir) || '.'), ui.out) + '\n');
      if (verify) {
        const { formatVerify } = await import('@fontphobia/crawler');
        ui.print(
          '\n' +
            highlight(
              formatVerify(verify, root)
                .replace('`fontphobia revert` restores the original fonts.', 'Build the site again to start over.')
                .replace(/\n*Rerun with `fontphobia verify`\.\n*$/, ''),
              ui.out,
            ) +
            '\n',
        );
      }
      if (nFailed)
        process.stdout.write(
          `${nFailed} page(s) could not be loaded:\n${Object.entries(failed)
            .slice(0, 10)
            .map(([p, e]) => `  ${p}: ${e}`)
            .join('\n')}\n`,
        );
    },
  );

cli
  .command('revert', 'Put the original @font-face declarations and preloads back from .fontphobia/manifest.json')
  .option('--cwd <dir>', 'Project root (default: current directory)')
  .option('--dry-run', 'Only show what would change')
  .option('--keep-kits', 'Leave Adobe kits changed by apply-kit as they are')
  .action(async (o: { cwd?: string; dryRun?: boolean; keepKits?: boolean; color?: boolean }) => {
    strs(o, 'cwd');
    const root = rootOf(o.cwd);
    const s = new Ui({ color: o.color }).out;
    // Adobe kits first (the API, with TYPEKIT_TOKEN); the files only once they're back.
    if (!o.dryRun) {
      const kp = await revertKits(root, (m) => process.stdout.write(m + '\n'), { keep: o.keepKits });
      if (kp.length) {
        process.stdout.write(`Problems (nothing else reverted):\n${kp.map((p) => `  ${p}`).join('\n')}\n`);
        process.exitCode = 1;
        return;
      }
    }
    const r = revertProject(root, { write: !o.dryRun });
    const L = [
      `${o.dryRun ? 'Would restore' : s.green('✓') + ' Restored'} ${r.files.length} file(s): ${r.files.join(', ') || 'none'}`,
    ];
    if (r.problems.length) {
      L.push(s.bold(s.red('Problems (manifest kept):')));
      for (const p of r.problems) L.push(`  ${p}`);
    }
    if (r.removed.length)
      L.push(`${o.dryRun ? 'Would remove' : 'Removed'} generated stylesheet(s): ${r.removed.join(', ')}`);
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
  .action(async (o: { cwd?: string; usage?: string; yes?: boolean; check?: boolean; color?: boolean }) => {
    strs(o, 'cwd', 'usage');
    const root = rootOf(o.cwd);
    const usage = readUsage(root, o.usage);
    if (!usage) throw new Error('No usage.json: run `fontphobia audit` first');
    const ui = new Ui({ color: o.color });
    process.exitCode = await applyKit(root, usage, {
      yes: o.yes,
      check: o.check,
      ask: (q) => ui.confirm(q.replace(/\s*\(y\/N\)\s*$/i, '')),
      interactive: ui.interactive,
      version: pkg.version,
      log: (m) => process.stdout.write(m + '\n'),
    });
  });

// The default (§3): audit, plan, then ask before writing (like ncu). --write/-u skips the question.
verifyOptions(
  buildOptions(
    auditCommand(cli.command('', 'Audit the site, plan, write after you confirm (or with --write), then verify')),
  ),
).action(async (o: AuditFlags & BuildFlags & VerifyFlags) => {
  const t0 = Date.now();
  const ui = new Ui({ color: o.color, ci: o.ci });
  ui.banner(pkg.version, `HarfBuzz ${harfbuzzVersion()}`);
  notifyUpdate(ui);
  await runAudit({ ...o, json: false }, { summary: false, ui, step: [1, 3] });
  const b = await runBuild(
    {
      ...o,
      usage: o.outDir ? join(o.outDir, 'usage.json') : undefined,
      json: false,
      prompt: true,
    },
    { ui, step: [2, 3] },
  );
  // Verify what was just written; the site is rebuilt first, since its sources changed.
  const v = b?.written ? await runVerify({ ...o, json: false, pages: undefined }, { ui, step: [3, 3] }) : undefined;
  if (!b) return;
  const e = ui.err;
  const saved = `${kb(b.now)} → ${e.bold(kb(b.after))} (${e.green(`${savedPct(b.now, b.after)} less`)})`;
  process.stderr.write('\n');
  if (b.unchanged) ui.ok(`Already subset: median font bytes per page ${saved}`);
  else if (!b.written) ui.note(`Median font bytes per page would go ${saved}.`, '  ');
  else if (v && !v.ok)
    ui.warn(
      `Written, but verify found differences (above).${b.applied.length ? ` The opt-ins picked (${b.applied.join(', ')}) change rendering by design; the diff images show by how much.` : ''} \`fontphobia revert\` puts the original rules back.`,
    );
  else
    ui.ok(
      `Done in ${seconds(Date.now() - t0)}: median font bytes per page ${saved}${v ? ', and every page renders the same' : ''}`,
    );
});

/** The closest command name, for a typo. */
function closest(word: string, names: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  const best = names.map((n) => ({ n, d: dist(word, n) })).toSorted((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(2, Math.floor(word.length / 3)) ? best.n : undefined;
}

cli.option('--no-color', 'Plain output, without colors (also NO_COLOR=1)');
cli.help((sections) => {
  for (const sec of sections) {
    if (sec.title === 'Usage') sec.body = '  $ fontphobia [command] [options]';
    if (sec.title === 'Commands')
      sec.body = sec.body.replace(
        /^ {2}( +)(Audit the site)/m,
        (_, sp: string, t: string) => `  ${'(none)'.padEnd(sp.length)}${t}`,
      );
    if (sec.title === 'Options') sec.body = sec.body.replace(/ \(default: true\)/g, '').replace(/ +$/gm, '');
  }
  const examples = {
    title: 'Examples',
    body: [
      '  $ fontphobia                      Audit, plan, ask before writing, then verify',
      '  $ fontphobia --write --ci         The same, without questions',
      '  $ fontphobia audit --url https://example.com',
      '  $ fontphobia build --allow limit-axes',
      '  $ fontphobia check                In CI or postbuild: are the subsets up to date?',
      '  $ fontphobia revert               Put the original @font-face rules back',
    ].join('\n'),
  };
  const i = sections.findIndex((x) => x.title?.startsWith('For more info'));
  return i >= 0 && !process.argv.slice(2).some((a) => !a.startsWith('-'))
    ? [...sections.slice(0, i), examples, ...sections.slice(i)]
    : sections;
});
cli.version(`${pkg.version} (HarfBuzz ${harfbuzzVersion()})`);

const { red } = ansiStyle(colorEnabled(process.stderr, !process.argv.includes('--no-color')));
try {
  // The default command takes no arguments: a word there is a mistyped command.
  if (process.argv[2] === 'help') process.argv.splice(2, 1, '--help');
  const first = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const names = cli.commands.map((c) => c.name).filter(Boolean);
  if (first !== undefined && process.argv[2] === first && !names.includes(first)) {
    const near = closest(first, names);
    throw new Error(
      `unknown command \`${first}\`.${near ? ` Did you mean \`${near}\`?` : ''} Run \`fontphobia --help\` for the commands.`,
    );
  }
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (e) {
  process.stderr.write(`${red('fontphobia:')} ${(e as Error).message}\n`);
  process.exitCode = 1;
}
