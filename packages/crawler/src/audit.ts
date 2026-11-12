// `fontphobia audit` (§7): get the site, find pages, visit each at every viewport and font size,
// and turn the visits into usage.json. The only environment-dependent step in the pipeline (§4).
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import {
  adobeFaceFacts,
  findBlock,
  findFontCheckCalls,
  findLocalFontCalls,
  isTypekitSheet,
  type AdobeFaceFacts,
  generatedFaces,
  readManifest,
  buildUsage,
  classifyFace,
  detectCss,
  detectProject,
  fontFacts,
  globToRegExp,
  harfbuzzVersion,
  htmlPages,
  indexFontFiles,
  isGlob,
  routesFromFiles,
  scanOffDom,
  usageToJson,
  type FaceSource,
  type FontFacts,
  type OffDomHit,
  type Project,
  type Visit,
} from '@fontphobia/core';
import { clearKeptOutput } from './isolate.ts';
import { openSite, since, type SiteOptions } from './site.ts';
import { matchesPage, pageKey, pageUrl, underBase, visitPage, type VisitOptions } from './visit.ts';
import { VisitCache } from './visit-cache.ts';

export interface AuditOptions extends SiteOptions {
  root: string;
  fontphobiaVersion: string;
  pages?: string[];
  ignore?: string[];
  viewports?: number[];
  locales?: string[];
  maxPages?: number;
  concurrency?: number;
  storageState?: string;
  /** Globs of pages behind the login (default: all pages, when storageState is set). */
  privatePages?: string[];
  /** The default-font-size sweep (§7.2). */
  fontSizeSweep?: boolean;
  maxWords?: number;
  /** Reuse cached visits whose resources are unchanged (M3.5, default true). */
  cache?: boolean;
  log?: (msg: string) => void;
}

export interface CrawlInfo {
  /** M3.5: visits reused from .fontphobia/cache/visits (nothing they loaded changed), made fresh, and stored for the next run (a visit whose resources couldn't all be read isn't). */
  cache?: { reused: number; visited: number; stored: number };
  framework: { id: string; name: string; tier: 1 | 2 };
  mode: 'static' | 'server' | 'url';
  source: string;
  built?: string;
  /** Age of the existing build that was crawled, and source files newer than it. */
  build?: { at: string; output: string; newer?: { file: string; at: string; count: number } };
  pages: string[];
  failed: Record<string, string>;
  dynamicRoutes: string[];
  routeSources: string[];
  visits: number;
  viewports: number[];
  fontSizes: number[];
  durationMs: number;
  /** adobe-fonts (§6.6): what the kit files hold, measured in memory (never written). */
  adobe?: AdobeFaceFacts[];
}

export interface AuditResult {
  usage: ReturnType<typeof usageToJson>;
  crawl: CrawlInfo;
  offDom: OffDomHit[];
  project: Project;
}

export const DEFAULT_VIEWPORTS = [360, 768, 1280, 1920];
const WIDE = 3840;
const NON_PAGE_EXT = /\.(?!html?$|php$|aspx?$)[a-z0-9]{1,5}$/i;

export async function launchChrome(args: string[] = []): Promise<Browser> {
  const executablePath = process.env.FONTPHOBIA_CHROME;
  try {
    return await chromium.launch({
      headless: true,
      args,
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    });
  } catch (e) {
    throw new Error(
      `Couldn't start Chrome (${(e as Error).message.split('\n')[0]}). fontphobia uses your installed Google Chrome; install it, or set FONTPHOBIA_CHROME to a Chrome or Chromium binary.`,
      { cause: e },
    );
  }
}

async function sitemapPaths(base: string, log: (m: string) => void): Promise<string[]> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue = [pageUrl('/sitemap.xml', base), pageUrl('/sitemap-index.xml', base)];
  try {
    const robots = await fetch(new URL('/robots.txt', base), { signal: AbortSignal.timeout(5000) });
    if (robots.ok)
      for (const m of (await robots.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        try {
          queue.push(pageUrl(new URL(m[1]!).pathname, base));
        } catch {
          /* bad */
        }
      }
  } catch {
    /* none */
  }
  while (queue.length && seen.size < 50) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    let xml: string;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok || !/xml/.test(r.headers.get('content-type') ?? 'xml')) continue;
      xml = await r.text();
    } catch {
      continue;
    }
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
    const isIndex = /<sitemapindex/i.test(xml);
    for (const l of locs) {
      let p: URL;
      try {
        p = new URL(l, base);
      } catch {
        continue;
      }
      // Sitemaps carry the production origin: keep the path, crawl it here.
      if (isIndex || p.pathname.endsWith('.xml')) queue.push(pageUrl(p.pathname, base));
      else out.add(p.pathname + p.search);
    }
  }
  if (out.size) log(`sitemap: ${out.size} pages`);
  return [...out];
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export async function audit(o: AuditOptions): Promise<AuditResult> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const root = resolve(o.root);
  const project = detectProject(root);
  const viewports = [...new Set(o.viewports?.length ? o.viewports : DEFAULT_VIEWPORTS)].toSorted((a, b) => a - b);
  const concurrency = o.concurrency ?? Math.max(1, Math.min(4, availableParallelism() - 1));
  const maxPages = o.maxPages ?? 500;
  const ignore = (o.ignore ?? []).map(globToRegExp);
  const include = (o.pages ?? []).filter(isGlob).map(globToRegExp);
  const privateRe = o.storageState ? (o.privatePages?.length ? o.privatePages : ['**']).map(globToRegExp) : [];

  // 1. The site: --url, --dist, --start-cmd, or what the profile finds (building first if needed).
  const opened = await openSite(o, project, log);
  const { site, built, age, mode, base, stop } = opened;

  let browser: Browser | undefined;
  try {
    browser = await launchChrome();
    const chrome = browser.version();
    log(`Chrome ${chrome} · ${project.profile.name} · ${mode}`);

    // 2. Seeds (§7.2): output HTML, build route lists, sitemap, config pages, '/'.
    const fileRoutes = routesFromFiles(project);
    // Every seed and key is the origin-absolute `pathname + search` the browser shows; a seed without
    // the base path is relative to the site's root (pageUrl).
    const keyOf = (p: string) => pageKey(pageUrl(p, base));
    const listed = new Set((o.pages ?? []).filter((p) => !isGlob(p)).map(keyOf));
    const allowed = (p: string) =>
      !matchesPage(ignore, p, base) && (!include.length || matchesPage(include, p, base) || listed.has(p));
    const seeds = new Set<string>([keyOf('/'), ...listed]);
    if (site?.mode === 'static') for (const p of htmlPages(site.dir!)) seeds.add(keyOf(p));
    for (const r of fileRoutes.routes) seeds.add(keyOf(r));
    for (const p of await sitemapPaths(base, log)) seeds.add(keyOf(p));
    // 404 pages render fonts too, but the server answers them for any path; crawl them by name only.
    const toUrl = (p: string) => pageUrl(p, base);

    const isPrivate = (p: string) => matchesPage(privateRe, p, base);
    const visitsOut: Visit[] = [];
    const bodies = new Map<string, Uint8Array>();
    const failed: Record<string, string> = {};
    const pages = new Set<string>();
    const contextOpts = {
      locale: 'en-US',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
      storageState: o.storageState,
      reducedMotion: 'no-preference' as const,
    };
    const bodyCache = new Map<string, { sha256: string; bytes: number }>();
    // M3.5: reuse a page's earlier visit when nothing it loaded changed.
    let cache: VisitCache | undefined;
    if (o.cache !== false) {
      const ctx = await browser.newContext(contextOpts);
      const userAgent = await (await ctx.newPage()).evaluate(() => navigator.userAgent).catch(() => '');
      await ctx.close();
      cache = new VisitCache(root, { chrome, fontphobia: o.fontphobiaVersion, userAgent, locales: o.locales ?? [] });
    }
    const origin = new URL(base).origin;
    const doVisit = async (url: string, vo: Omit<VisitOptions, 'locales'>) => {
      const key = vo.private ? undefined : cache?.keyOf(url, vo);
      const hit = key ? await cache!.get(key, origin) : undefined;
      if (hit) {
        for (const [k, b] of hit.bodies) bodies.set(k, b);
        return hit;
      }
      const ctx = await browser!.newContext(contextOpts);
      try {
        const r = await visitPage(ctx, url, { ...vo, locales: o.locales ?? [], bodyCache });
        for (const [k, b] of r.bodies) bodies.set(k, b);
        if (key) cache!.put(key, origin, r);
        return r;
      } finally {
        await ctx.close().catch(() => {});
      }
    };

    // 3. Discovery at the first viewport: BFS over same-origin links (§7.2).
    const first = viewports.includes(1280) ? 1280 : viewports[viewports.length - 1]!;
    const queued = new Set<string>();
    let frontier = [...seeds].filter(allowed).toSorted();
    for (const p of frontier) queued.add(p);
    const byPage = new Map<string, { emMq: boolean; textScale: boolean; url: string }>();
    while (frontier.length) {
      const next: string[] = [];
      const missed: string[] = [];
      await pool(frontier, concurrency, async (p) => {
        const r = await doVisit(toUrl(p), { viewport: first, fontSize: 16, private: isPrivate(p) });
        if (!r.visit) {
          failed[p] = r.error ?? `HTTP ${r.status}`;
          missed.push(p);
          return;
        }
        const key = r.visit.page;
        if (pages.has(key)) return; // a redirect landed on a page we already have
        pages.add(key);
        visitsOut.push(r.visit);
        byPage.set(key, { emMq: !!r.visit.emMediaQueries, textScale: !!r.visit.textScaleMeta, url: r.finalUrl });
        for (const l of r.links) {
          const u = new URL(l);
          const lp = u.pathname + u.search;
          // Outside the base path: another site on the same origin.
          if (NON_PAGE_EXT.test(u.pathname) || !underBase(u.pathname, base) || queued.has(lp) || !allowed(lp)) continue;
          if (queued.size >= maxPages) continue;
          queued.add(lp);
          next.push(lp);
        }
      });
      missed.sort();
      log(
        `pages: ${pages.size} (${next.length} more found${
          missed.length
            ? `, ${missed.length} failed: ${missed
                .slice(0, 3)
                .map((p) => `${p} ${failed[p]}`)
                .join('; ')}${missed.length > 3 ? '; …' : ''}`
            : ''
        })`,
      );
      frontier = next.toSorted();
    }
    if (!pages.size)
      throw new Error(
        `No page loaded from ${base}: ${Object.entries(failed)
          .slice(0, 5)
          .map(([p, e]) => `${p} ${e}`)
          .join('; ')}`,
      );
    if (queued.size >= maxPages) log(`stopped discovering at ${maxPages} pages (--max-pages)`);

    // 4. Every other viewport, and the default-font-size sweep (§7.2).
    type Task = { page: string; url: string } & Omit<VisitOptions, 'locales'>;
    const tasks: Task[] = [];
    const narrow = viewports[0]!;
    const fontSizes = new Set<number>([16]);
    for (const [page, info] of [...byPage].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
      const priv = isPrivate(page);
      for (const w of viewports)
        if (w !== first) tasks.push({ page, url: info.url, viewport: w, fontSize: 16, private: priv });
      if (o.fontSizeSweep !== false) {
        const sizes = info.emMq ? [9, 12, 20, 24, 72] : [9, 72];
        for (const s of sizes) {
          fontSizes.add(s);
          tasks.push({ page, url: info.url, viewport: narrow, fontSize: s, private: priv });
        }
        for (const s of [...sizes, 16]) tasks.push({ page, url: info.url, viewport: WIDE, fontSize: s, private: priv });
        if (info.textScale)
          for (const ts of [0.85, 2])
            for (const w of [narrow, WIDE])
              tasks.push({ page, url: info.url, viewport: w, fontSize: 16, textScale: ts, private: priv });
      }
    }
    let done = 0;
    await pool(tasks, concurrency, async (t) => {
      const r = await doVisit(t.url, t);
      if (r.visit) {
        r.visit.page = t.page;
        visitsOut.push(r.visit);
      } else
        failed[`${t.page} @${t.viewport}${t.fontSize !== 16 ? `/fs${t.fontSize}` : ''}`] =
          r.error ?? `HTTP ${r.status}`;
      if (++done % 25 === 0) log(`visits: ${done}/${tasks.length}`);
    });

    // Entries for pages and settings this run didn't touch are stale; keep them when pages were filtered.
    if (cache && !include.length && !(o.pages ?? []).length) cache.prune();
    if (cache) log(`visits: ${cache.stats.hits} reused from the cache, ${visitsOut.length - cache.stats.hits} made`);

    // 5. Font facts, usage, sources.
    const facts = new Map<string, FontFacts>();
    for (const [sha, b] of [...bodies].toSorted(([a], [c]) => (a < c ? -1 : 1))) {
      try {
        facts.set(sha, await fontFacts(b));
      } catch {
        /* not a font (an HTML 200 for a missing file) */
      }
    }
    // Faces fontphobia generated fold back into the original face (§M4 notes).
    const manifest = readManifest(root);
    const usage = buildUsage(visitsOut, facts, {
      locales: o.locales,
      maxWords: o.maxWords ?? 10_000,
      generated: generatedFaces(manifest),
    });
    const outputDirs = site?.dir ? [relative(opened.root, site.dir).split(sep).join('/')] : [];
    const css = detectCss(root, { outputDirs });
    const fontIndex = indexFontFiles(root, { outputDirs });
    const sources = new Map<string, FaceSource>();
    for (const [id, f] of usage.faces) {
      const e = f.fixedId ? manifest?.entries[f.fixedId] : undefined;
      if (e) {
        let line: number | undefined;
        try {
          const t = readFileSync(resolve(root, e.stylesheet), 'utf8');
          const b = findBlock(t, e.id);
          if (b) line = t.slice(0, b.start).split('\n').length;
        } catch {
          /* gone */
        }
        sources.set(id, {
          adapter: e.adapter,
          file: e.stylesheet,
          line,
          fontFile: e.source.file,
          sha256: e.source.sha256,
          note: 'generated by fontphobia',
        });
      } else sources.set(id, classifyFace(f, css, fontIndex));
    }
    // next/font/local (§6.3): a face whose file no stylesheet declares, loaded by a localFont() call.
    const fromCall = (x: FaceSource) =>
      (x.adapter === 'manual' || (x.adapter === 'next-font-local' && !x.file)) && !!x.fontFile;
    const calls = [...sources.values()].some(fromCall) ? findLocalFontCalls(root) : [];
    for (const [id, src] of sources) {
      if (!fromCall(src)) continue;
      const call = calls.find((c) => c.srcs.some((x) => x.file === src.fontFile));
      if (call)
        sources.set(id, { adapter: 'next-font-local', file: call.file, line: call.line, fontFile: src.fontFile });
    }
    const offDom = [
      ...scanOffDom(root),
      ...findFontCheckCalls(root)
        .filter((c) => c.fixable)
        .map((c) => ({
          file: c.file,
          line: c.line,
          kind: 'font check',
          text: c.call.length > 70 ? c.call.slice(0, 67) + '…' : c.call,
        })),
    ];

    const covered = [...pages];
    const dynamicRoutes = fileRoutes.dynamic.filter((d) => {
      const re = new RegExp(
        '^' +
          d
            .split('/')
            .map((s) => (/^\[|^\$|^:/.test(s) ? '[^/]+' : s.replace(/[.+?^${}()|\\]/g, '\\$&')))
            .join('/') +
          '/?$',
      );
      return !covered.some((p) => re.test(p.split('?')[0]!));
    });
    const crawl: CrawlInfo = {
      framework: { id: project.profile.id, name: project.profile.name, tier: project.profile.tier },
      mode,
      source:
        o.url ??
        (site?.dir !== undefined
          ? relative(opened.root, site.dir).split(sep).join('/') || '.'
          : (site?.server?.cmd ?? '')),
      built,
      build: age
        ? {
            at: new Date(age.builtAt).toISOString(),
            output: age.output,
            newer: age.newer && {
              file: age.newer.file,
              at: new Date(age.newer.mtime).toISOString(),
              count: age.newer.count,
            },
          }
        : undefined,
      pages: [...pages].toSorted(),
      failed: Object.fromEntries(Object.entries(failed).toSorted()),
      dynamicRoutes,
      routeSources: fileRoutes.sources,
      visits: visitsOut.length,
      cache: cache
        ? { reused: cache.stats.hits, visited: visitsOut.length - cache.stats.hits, stored: cache.stats.stored }
        : undefined,
      viewports,
      fontSizes: [...fontSizes].toSorted((a, b) => a - b),
      durationMs: Date.now() - t0,
    };
    const json = usageToJson(
      usage,
      {
        fontphobia: o.fontphobiaVersion,
        harfbuzz: harfbuzzVersion(),
        chrome,
        framework: project.profile.id,
        mode,
        viewports,
        fontSizes: crawl.fontSizes,
      },
      sources,
      {
        declarations: css.map((s) => ({
          file: s.file,
          line: s.line,
          family: s.rule.family,
          weight: s.rule.descriptors['font-weight'],
          style: s.rule.descriptors['font-style'],
          files: s.files.map((f) => f.path ?? f.url),
          manual: s.manual,
        })),
        offDom: offDom.length ? offDom : undefined,
      },
    );
    // adobe-fonts (§6.6): the kit files, from this crawl's downloads (or fetched again, in memory).
    const adobe: AdobeFaceFacts[] = [];
    for (const [id, f] of Object.entries(json.faces)) {
      if (!isTypekitSheet(f.sheet)) continue;
      const file = f.files[0];
      if (!file) continue;
      let bytes = file.sha256 ? bodies.get(file.sha256) : undefined;
      if (!bytes) {
        try {
          const r = await fetch(new URL(file.url, 'https://use.typekit.net/').href, {
            signal: AbortSignal.timeout(30_000),
          });
          if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
        } catch {
          /* offline */
        }
      }
      if (bytes) {
        try {
          adobe.push(await adobeFaceFacts(f, bytes, { kit: f.sheet, id }));
        } catch {
          /* not a font */
        }
      }
    }
    if (adobe.length) crawl.adobe = adobe;
    return { usage: json, crawl, offDom, project };
  } finally {
    await browser?.close().catch(() => {});
    // What build reads from the output (an eject's font files and CSS): kept from fontphobia's own
    // build in a copy, or cleared when the project's own output was crawled.
    try {
      if (opened.keepOutput) opened.keepOutput();
      else if (mode !== 'url') clearKeptOutput(root);
    } catch (e) {
      log(`couldn't keep the build output: ${(e as Error).message}`);
    }
    await stop();
  }
}

export { pageKey, since };
