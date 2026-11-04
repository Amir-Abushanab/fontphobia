// `fontphobia verify`, the browser layer (§10.3), overlay mode: load each page twice from the same
// build, "after" as served and "before" with the original fonts swapped back in (core/verify/overlay),
// and compare layout (text boxes, and fonts per node on Chromium) and pixels. Then bytes per page,
// and that each extended and rest file loads only on pages that use one of its characters.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { firefox, webkit, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  codePointsOf, createOverlay, detectProject, nameStrings, parseUnicodeRange, woff2Decompress,
  type Manifest, type Overlay, type StaticVerify, type UsageFileJson,
} from '@fontphobia/core';
import { launchChrome } from './audit.ts';
import { playwrightVersion, startLinuxBrowsers, stopOnExit, type LinuxBrowsers, type Runtime } from './linux.ts';
import { openSite, type OpenSite, type SiteOptions } from './site.ts';
import { worktreeBaseline, type Baseline } from './baseline.ts';

/** Host browsers, and the same engines in the pinned Playwright Linux image (`linux-*`, via a container runtime). */
export type Engine = 'chromium' | 'firefox' | 'webkit' | 'linux-chromium' | 'linux-firefox' | 'linux-webkit';
export const ENGINES: Engine[] = ['chromium', 'firefox', 'webkit', 'linux-chromium', 'linux-firefox', 'linux-webkit'];
/**
 * `unrelated`: pixels differ only in text drawn with fonts fontphobia didn't change (Google Fonts,
 * system fonts), at identical layout. Our files can't cause that; the browser's rasterizer can (CI).
 */
export type CompareClass = 'identical' | 'sub-pixel rounding' | 'unrelated' | 'flaky' | 'regression' | 'content changed' | 'failed';

export interface VerifyOptions extends SiteOptions {
  root: string;
  usage: UsageFileJson;
  manifest: Manifest;
  /** The deterministic layers' result: rounding is only accepted where shaping reported it. */
  staticResult?: StaticVerify;
  /** Pages that are always verified (config `pages`). */
  pages?: string[];
  /** Cap before the set cover kicks in (default 200). */
  maxPages?: number;
  viewports?: number[];
  dprs?: number[];
  browsers?: Engine[];
  /**
   * The worst case for rounding (§10.3): Chrome in the pinned Linux image with default flags at DPR 1,
   * where it hints and snaps advances to whole pixels. Adds `linux-chromium` at DPR 1.
   */
  hinting?: boolean;
  /**
   * How "before" is made (§10.3). overlay (default): the same build with the original fonts swapped back
   * in. worktree: HEAD built in a temporary git worktree, with fontphobia's committed edits reverted.
   */
  baseline?: 'overlay' | 'worktree';
  /** Container runtime for `linux-*` engines (default: the first that answers: Apple container, Docker, Podman). */
  runtime?: Runtime;
  concurrency?: number;
  /** Where diff images go (default <root>/.fontphobia/verify). */
  outDir?: string;
  log?: (m: string) => void;
}

export interface NodeDiff { text: string; cause: string }

export interface Comparison {
  page: string;
  viewport: number;
  dpr: number;
  browser: Engine;
  class: CompareClass;
  causes: string[];
  /** Text nodes compared and those whose boxes moved. */
  nodes: number;
  moved: number;
  /** Largest horizontal change of a text box (CSS px). */
  maxDx: number;
  pixels: number;
  examples: NodeDiff[];
  diffImage?: string;
}

export interface PageFonts { page: string; before: { bytes: number; requests: number }; after: { bytes: number; requests: number }; faces: Record<string, { before: number; after: number }> }

export interface BrowserVerify {
  site: { mode: OpenSite['mode']; base: string; built?: string };
  baseline: 'overlay' | 'worktree';
  browsers: { engine: Engine; version: string }[];
  pages: string[];
  /** Pages left out by the set cover (above maxPages). */
  skipped: number;
  comparisons: Comparison[];
  bytes: PageFonts[];
  /** Loads that shouldn't happen: an extended or rest file on a page using none of its characters, a font 404, a face drawn without its outputs. */
  loads: { page: string; problem: string }[];
  /** Outputs the browser's font sanitizer (OTS in Chrome) rejects. */
  rejected: { file: string; browser: Engine; error: string }[];
  ok: boolean;
  durationMs: number;
}

const STABLE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/** §10.3 page selection: everything up to the cap, else a greedy set cover of face × character class, plus config pages. */
export function selectPages(usage: UsageFileJson, entries: Set<string>, max: number, always: string[] = []): { pages: string[]; skipped: number } {
  const all = Object.entries(usage.pages).filter(([, p]) => !p.private && Object.keys(p.faces).some((id) => entries.has(id))).map(([k]) => k).sort();
  const forced = always.filter((p) => usage.pages[p]);
  if (all.length <= max) return { pages: [...new Set([...all, ...forced])].sort(), skipped: 0 };
  const cls = (cp: number) => {
    const ch = String.fromCodePoint(cp);
    if (cp < 0x80) return 'ascii';
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) return 'cjk';
    if (/\p{Script=Latin}|\p{M}/u.test(ch)) return 'accented';
    return 'other';
  };
  const items = new Map<string, Set<string>>();
  for (const p of all) {
    const s = new Set<string>();
    for (const [id, r] of Object.entries(usage.pages[p]!.faces)) if (entries.has(id)) for (const c of codePointsOf(parseUnicodeRange(r))) s.add(`${id}|${cls(c)}`);
    items.set(p, s);
  }
  const chosen = new Set(forced);
  const covered = new Set<string>();
  for (const p of chosen) for (const x of items.get(p) ?? []) covered.add(x);
  for (;;) {
    let best: string | undefined, gain = 0;
    for (const p of all) {
      if (chosen.has(p)) continue;
      const g = [...items.get(p)!].filter((x) => !covered.has(x)).length;
      if (g > gain) { best = p; gain = g; }
    }
    if (!best) break;
    chosen.add(best);
    for (const x of items.get(best)!) covered.add(x);
  }
  return { pages: [...chosen].sort(), skipped: all.length - [...chosen].filter((p) => all.includes(p)).length };
}

interface Box { x: number; y: number; w: number; h: number }
interface Snapshot {
  /** Text layout objects in document order: key, text, line boxes, owning element (Chromium backend id). */
  nodes: { key: string; text: string; boxes: Box[]; owner?: number }[];
  png: PNG;
  fonts: { url: string; bytes: number; status: number }[];
}

async function launch(engine: Engine, linux: () => Promise<LinuxBrowsers>): Promise<Browser> {
  // Default flags in the image: hinting on, whole-pixel advances. That is the point of the worst case.
  if (engine.startsWith('linux-')) return (await linux()).launch(engine.slice(6) as 'chromium' | 'firefox' | 'webkit');
  if (engine === 'chromium') {
    // Linux hints and snaps text positions to whole pixels by default; the exact configuration turns that off (§10.3, spike 9).
    return launchChrome(process.platform === 'linux' ? ['--font-render-hinting=none'] : []);
  }
  const type = engine === 'firefox' ? firefox : webkit;
  try { return await type.launch({ headless: true }); } catch (e) {
    const msg = (e as Error).message;
    const said = [...msg.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/\[err\] (.+)/g)].map((m) => m[1]!.trim().replace(/\.$/, '')).filter((l) => !/headless mode/i.test(l)).pop();
    if (/Executable doesn't exist/i.test(msg)) throw new Error(`${engine} isn't installed. Install Playwright's build with \`pnpm dlx playwright@${playwrightVersion()} install ${engine}\`, or use linux-${engine} (runs in a container).`);
    // Playwright's Firefox opens ~/Library/Application Support/Firefox even with a temporary profile.
    // When a real Firefox is installed, macOS protects that folder as another app's data (com.apple.macl),
    // so the launch fails unless the terminal has Full Disk Access (M5 notes).
    const hint = engine === 'firefox' && /profile folder/i.test(said ?? '') && process.platform === 'darwin'
      ? ' macOS protects ~/Library/Application Support/Firefox as your installed Firefox\'s data, and Playwright\'s Firefox needs it; giving your terminal Full Disk Access allows it.'
      : '';
    throw new Error(`Couldn't start ${engine}${said ? `: ${said}` : ` (${msg.split('\n')[0]})`}.${hint} Use linux-${engine} to run it in a container instead.`);
  }
}

/**
 * Third-party CSS and fonts (Google Fonts, CDNs), as first served in this run, per engine. Google can
 * serve different bytes for one URL (§6.5), so every load gets the same snapshot: otherwise "before"
 * and "after" can differ by fonts fontphobia never touched.
 */
type Snapshots = Map<string, Promise<{ status: number; headers: Record<string, string>; body: Buffer } | undefined>>;

/** `before`: rewrite to the original fonts (overlay); `plain`: serve as is and note which outputs the CSS uses. */
async function context(browser: Browser, o: { viewport: number; dpr: number; engine: Engine }, overlay: Overlay, mode: 'before' | 'plain', root: string, hits: Set<string>, local: Set<string>, snapshots: Snapshots): Promise<BrowserContext> {
  const before = mode === 'before';
  const ctx = await browser.newContext({ viewport: { width: o.viewport, height: 900 }, deviceScaleFactor: o.dpr, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' });
  await ctx.clock.setFixedTime(FIXED_TIME);
  await ctx.addInitScript(({ css }) => {
    // Seeded Math.random (mulberry32), so both loads see the same "random" content.
    let a = 0x9e3779b9;
    Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const add = () => { const s = document.createElement('style'); s.textContent = css; (document.head ?? document.documentElement).append(s); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  }, { css: STABLE_CSS });
  // Adobe's font server counts page views (§6.6).
  await ctx.route(/^https?:\/\/p\.typekit\.net\//, (r) => r.abort());
  await ctx.route(/.*/, async (route) => {
    const req = route.request();
    let url: URL;
    try { url = new URL(req.url()); } catch { return route.continue(); }
    const src = overlay.sourceFile(url.pathname);
    if (src) {
      const p = join(root, src.file);
      if (!existsSync(p)) return route.fulfill({ status: 404, body: 'source font missing' });
      return route.fulfill({ status: 200, body: readFileSync(p), headers: { 'content-type': 'font/' + (src.file.split('.').pop() ?? 'ttf'), 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
    const type = req.resourceType();
    const thirdParty = !local.has(url.origin) && (type === 'font' || type === 'stylesheet');
    if (type !== 'document' && type !== 'stylesheet' && !thirdParty) return route.continue();
    let snap: { status: number; headers: Record<string, string>; body: Buffer } | undefined;
    if (thirdParty) {
      // A tightened Google URL (§6.5): "before" loads the original one.
      const orig = before && type === 'stylesheet' ? overlay.originalSheet(req.url()) : undefined;
      const key = `${o.engine} ${orig ?? req.url()}`;
      let p = snapshots.get(key);
      if (!p) {
        p = route.fetch(orig ? { url: orig } : undefined).then(async (r) => {
          const headers = { ...r.headers() };
          delete headers['content-length']; delete headers['content-encoding'];
          return { status: r.status(), headers, body: await r.body() };
        }, () => undefined);
        snapshots.set(key, p);
      }
      snap = await p;
      if (!snap) return route.abort();
      if (type === 'font') return route.fulfill({ status: snap.status, headers: snap.headers, body: snap.body });
    }
    let resp;
    if (!snap) { try { resp = await route.fetch(); } catch { return route.continue(); } }
    const respHeaders = snap ? snap.headers : resp!.headers();
    const ct = respHeaders['content-type'] ?? '';
    const isCss = type === 'stylesheet' || /css/i.test(ct);
    if (!isCss && !/html/i.test(ct)) return snap ? route.fulfill({ status: snap.status, headers: snap.headers, body: snap.body }) : route.fulfill({ response: resp! });
    const body = snap ? snap.body.toString('utf8') : await resp!.text();
    let out: string | undefined;
    if (before) out = isCss ? overlay.restoreCss(body, hits) : overlay.restoreHtml(body, hits);
    else for (const id of overlay.scan(isCss ? body : (body.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join('\n').replace(/<\/?style\b[^>]*>/gi, ''))) hits.add(id);
    const headers = { ...respHeaders };
    delete headers['content-length']; delete headers['content-encoding'];
    return route.fulfill({ status: snap ? snap.status : resp!.status(), headers, body: out ?? body });
  });
  return ctx;
}

/** Load, settle (§10.3 "Stable screenshots"), and capture layout, fonts and pixels. */
async function capture(ctx: BrowserContext, url: string, engine: Engine): Promise<{ page: Page; cdp?: CDPSession; snap: Snapshot }> {
  const page = await ctx.newPage();
  const fonts: Snapshot['fonts'] = [];
  const pending: Promise<void>[] = [];
  page.on('response', (r) => {
    if (r.request().resourceType() !== 'font') return;
    pending.push(r.body().then((b) => { fonts.push({ url: r.url(), bytes: b.byteLength, status: r.status() }); }, () => { fonts.push({ url: r.url(), bytes: 0, status: r.status() }); }));
  });
  const resp = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp?.status() ?? 0}`);
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll<HTMLImageElement | HTMLIFrameElement>('[loading="lazy"]')) el.loading = 'eager';
    const h = () => document.documentElement.scrollHeight;
    for (let y = 0, i = 0; y < h() && i < 12; y += innerHeight, i++) { scrollTo(0, y); await new Promise((r) => requestAnimationFrame(() => r(null))); }
    scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const fontsSettled = () => page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.fonts].filter((f) => f.status === 'loading').map((f) => f.loaded.catch(() => {})));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return [...document.fonts].some((f) => f.status === 'loading');
  });
  for (let i = 0; i < 5 && (await fontsSettled()); i++);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await Promise.all(pending);

  let nodes: Snapshot['nodes'];
  let cdp: CDPSession | undefined;
  if (engine.endsWith('chromium')) {
    cdp = await ctx.newCDPSession(page);
    const snap = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    const S = snap.strings;
    nodes = [];
    snap.documents.forEach((doc, di) => {
      const L = doc.layout, T = doc.textBoxes, n = doc.nodes;
      const boxes = new Map<number, Box[]>();
      T.layoutIndex.forEach((li, k) => { const b = T.bounds[k]!; (boxes.get(li) ?? boxes.set(li, []).get(li)!).push({ x: b[0]!, y: b[1]!, w: b[2]!, h: b[3]! }); });
      L.nodeIndex.forEach((ni, li) => {
        const t = L.text[li];
        const text = t !== undefined && t >= 0 ? S[t]! : '';
        if (!text.trim()) return;
        // The owning element: the nearest element ancestor that isn't a pseudo-element.
        let owner: number | undefined;
        for (let i = n.parentIndex![ni]!; i >= 0; i = n.parentIndex![i]!) if (n.nodeType![i] === 1) { owner = n.backendNodeId![i]; break; }
        nodes.push({ key: `${di}:${ni}:${li}`, text, boxes: boxes.get(li) ?? [], owner });
      });
    });
  } else {
    nodes = await page.evaluate(() => {
      const out: { key: string; text: string; boxes: { x: number; y: number; w: number; h: number }[] }[] = [];
      const walk = (root: Node, prefix: string) => {
        const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let i = 0;
        for (let n = it.nextNode(); n; n = it.nextNode(), i++) {
          if (n.nodeType === 1) { const sr = (n as Element).shadowRoot; if (sr) walk(sr, `${prefix}${i}/`); continue; }
          const text = n.nodeValue ?? '';
          if (!text.trim()) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          const boxes = [...r.getClientRects()].map((b) => ({ x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height }));
          if (boxes.length) out.push({ key: `${prefix}${i}`, text, boxes });
        }
      };
      walk(document, '');
      return out;
    });
  }
  let shot: Buffer;
  try { shot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', scale: 'device' }); } catch { shot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device' }); }
  return { page, cdp, snap: { nodes, png: PNG.sync.read(shot), fonts } };
}

async function platformFonts(cdp: CDPSession | undefined, owners: number[]): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>();
  if (!cdp || !owners.length) return out;
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
    const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: owners });
    await Promise.all(owners.map(async (b, i) => {
      try {
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[i]! });
        const m = new Map<string, number>();
        for (const f of fonts) { const k = `${f.isCustomFont ? '' : 'system '}${f.familyName}`; m.set(k, (m.get(k) ?? 0) + f.glyphCount); }
        out.set(b, m);
      } catch { /* gone */ }
    }));
  } catch { /* page closed */ }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const snippet = (t: string) => JSON.stringify(t.length > 40 ? t.slice(0, 39) + '…' : t);
const slug = (p: string) => (p.replace(/^\/|\/$/g, '').replace(/[^a-z0-9._-]+/gi, '_') || 'index');

export async function verifyBrowser(o: VerifyOptions): Promise<BrowserVerify> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const root = resolve(o.root);
  const project = detectProject(root);
  const overlay = createOverlay(o.manifest);
  const entryIds = new Set(Object.keys(o.manifest.entries));
  const { pages, skipped } = selectPages(o.usage, entryIds, o.maxPages ?? 200, o.pages);
  if (skipped) log(`verifying ${pages.length} pages chosen to cover every face × character class (${skipped} more not visited; raise --max-pages to include them)`);
  const viewports = o.viewports?.length ? o.viewports : o.usage.meta.viewports;
  const dprs = o.dprs?.length ? o.dprs : [1, 2];
  const engines: Engine[] = [...new Set([...(o.browsers?.length ? o.browsers : ['chromium' as const]), ...(o.hinting ? ['linux-chromium' as const] : [])])];
  const bad = engines.filter((e) => !ENGINES.includes(e));
  if (bad.length) throw new Error(`Unknown browser ${bad.join(', ')}; use ${ENGINES.join(', ')}`);
  // --hinting alone: the worst case is DPR 1 only.
  const dprsFor = (e: Engine) => (e === 'linux-chromium' && o.hinting && !o.browsers?.includes('linux-chromium') ? [1] : dprs);
  const outDir = o.outDir ?? join(root, '.fontphobia', 'verify');
  const limitFaces = new Set(Object.values(o.manifest.entries).filter((e) => e.plan.optIns.includes('limit-axes')).map((e) => e.id));
  // The internal family names of fontphobia's files, as getPlatformFontsForNode reports them.
  const ours = new Set<string>();
  for (const e of Object.values(o.manifest.entries)) {
    if (e.plan.rename) ours.add(e.plan.rename.to.toLowerCase());
    const out = e.outputs[0];
    if (!out || !existsSync(join(root, out.file))) continue;
    try { const n = nameStrings(await woff2Decompress(new Uint8Array(readFileSync(join(root, out.file))))); for (const id of [1, 16, 21]) { const v = n.get(id); if (v) ours.add(v.toLowerCase()); } } catch { /* verifyStatic reports it */ }
  }
  const roundingOk = (id: string) => limitFaces.has(id) && !(o.staticResult?.shaping.find((s) => s.id === id)?.regressions);

  // A verify of an old build checks nothing: rebuild whenever the source is newer (§M4: build --write edits it).
  const site = await openSite({ ...o, onStale: o.onStale ?? (() => true) }, project, log);
  let baseline: Baseline | undefined;
  // next/font/google and Astro narrowing and ejects change what the framework builds: only a second build can show "before".
  const baselineMode = o.baseline ?? (o.manifest.options?.length || Object.values(o.manifest.ejects ?? {}).some((e) => e.kind === 'next-font-google' || e.kind === 'astro-fonts' || e.kind === 'nuxt-fonts') ? 'worktree' : 'overlay');
  if (baselineMode === 'worktree') {
    try { baseline = await worktreeBaseline(root, o.manifest, o, log); } catch (e) { await site.stop(); throw e; }
  }
  const browsers: { engine: Engine; browser: Browser }[] = [];
  const comparisons: Comparison[] = [];
  const bytes = new Map<string, PageFonts>();
  const loadProblems = new Map<string, string>();
  const rejected: BrowserVerify['rejected'] = [];
  const usedInAfter = new Set<string>();
  let linux: Promise<LinuxBrowsers> | undefined;
  let unhook = () => {};
  const getLinux = () => (linux ??= startLinuxBrowsers({ runtime: o.runtime, log }).then((l) => { unhook = stopOnExit(l); return l; }));
  try {
    for (const e of engines) browsers.push({ engine: e, browser: await launch(e, getLinux) });
    const versions = browsers.map((b) => ({ engine: b.engine, version: b.browser.version() }));
    log(`${versions.map((v) => `${v.engine} ${v.version}`).join(', ')} · ${site.mode} · ${pages.length} page(s) × ${viewports.length} viewport(s) × DPR ${dprs.join(',')}`);

    // §9.5, deferred from build: the browser's font sanitizer must accept every output.
    for (const { engine, browser } of browsers) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      for (const e of Object.values(o.manifest.entries)) for (const out of e.outputs) {
        const p = join(root, out.file);
        if (!existsSync(p)) continue;
        const err = await page.evaluate(async (b64) => {
          try { const f = new FontFace('fontphobia-check', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await f.load(); return ''; } catch (x) { return String((x as Error).message ?? x); }
        }, readFileSync(p).toString('base64'));
        if (err) rejected.push({ file: out.file, browser: engine, error: err });
      }
      await ctx.close();
    }

    const local = new Set([new URL(site.base).origin, ...(baseline ? [new URL(baseline.site.base).origin] : [])]);
    const snapshots: Snapshots = new Map();
    type Task = { page: string; viewport: number; dpr: number; engine: Engine; browser: Browser };
    const tasks: Task[] = [];
    for (const b of browsers) for (const page of pages) for (const viewport of viewports) for (const dpr of dprsFor(b.engine)) tasks.push({ page, viewport, dpr, engine: b.engine, browser: b.browser });
    const concurrency = o.concurrency ?? Math.max(1, Math.min(4, availableParallelism() - 1));
    let done = 0;
    await pool(tasks, concurrency, async (t) => {
      const url = new URL(t.page.replace(/^\//, ''), site.base).href;
      const beforeUrl = baseline ? new URL(t.page.replace(/^\//, ''), baseline.site.base).href : url;
      const base: Comparison = { page: t.page, viewport: t.viewport, dpr: t.dpr, browser: t.engine, class: 'failed', causes: [], nodes: 0, moved: 0, maxDx: 0, pixels: 0, examples: [] };
      const hitsB = new Set<string>(), hitsA = new Set<string>();
      const [cb, ca] = await Promise.all([context(t.browser, t, overlay, baseline ? 'plain' : 'before', root, hitsB, local, snapshots), context(t.browser, t, overlay, 'plain', root, hitsA, local, snapshots)]);
      try {
        const [b, a] = await Promise.all([capture(cb, beforeUrl, t.engine), capture(ca, url, t.engine)]);
        for (const id of hitsA) usedInAfter.add(id);
        const drawn = Object.keys(o.usage.pages[t.page]?.faces ?? {}).filter((id) => entryIds.has(id));
        let c = await compare(t, base, b, a, drawn.some(roundingOk), o.manifest, outDir, ours);
        // Pixels only, at identical layout: load both again. Browsers occasionally rasterize a glyph a
        // pixel differently between loads; a difference that doesn't come back is noise.
        // Measured: the original Fraunces against itself differs by a pixel on about one load in four
        // in Linux Chromium, sometimes twice running. Up to three more loads; any identical one wins,
        // and so does any earlier load of one side whose pixels match a load of the other (a pixel that
        // toggles at random makes every same-attempt pair differ about one time in fifty; a real
        // change never matches at all).
        const loadsB = [b.snap.png], loadsA = [a.snap.png];
        const same = (x: PNG, y: PNG) => x.width === y.width && x.height === y.height && x.data.equals(y.data);
        for (let attempt = 0; attempt < 3 && c.class === 'regression' && !c.moved && c.causes.every((x) => /^pixels differ/.test(x)); attempt++) {
          const [cb2, ca2] = await Promise.all([context(t.browser, t, overlay, baseline ? 'plain' : 'before', root, new Set(), local, snapshots), context(t.browser, t, overlay, 'plain', root, new Set(), local, snapshots)]);
          try {
            const [b2, a2] = await Promise.all([capture(cb2, beforeUrl, t.engine), capture(ca2, url, t.engine)]);
            const again = await compare(t, base, b2, a2, drawn.some(roundingOk), o.manifest, outDir, ours);
            loadsB.push(b2.snap.png); loadsA.push(a2.snap.png);
            if (again.class === 'identical') c = { ...c, class: 'flaky', causes: [`${c.causes.join('; ')}; identical on load ${attempt + 2}`] };
            else if (loadsB.some((x) => loadsA.some((y) => same(x, y)))) c = { ...c, class: 'flaky', causes: [`${c.causes.join('; ')}; a load of the original and a load of the new files are pixel-identical (${loadsB.length} loads each)`] };
            else {
              // The noise floor: does the original differ from itself between two loads?
              const self = await compare(t, base, b, b2, false, o.manifest, join(outDir, 'noise'), ours);
              if (self.class !== 'identical' && self.pixels >= again.pixels) c = { ...c, class: 'flaky', causes: [`${c.causes.join('; ')}; the original fonts differ from themselves between loads by ${self.pixels} px`] };
            }
          } finally { await Promise.all([cb2.close().catch(() => {}), ca2.close().catch(() => {})]); }
        }
        comparisons.push(c);
        if (t.dpr === dprsFor(t.engine)[0] && t.engine === engines[0]) record(t.page, b.snap.fonts, a.snap.fonts, hitsA);
      } catch (e) {
        comparisons.push({ ...base, causes: [(e as Error).message.split('\n')[0]!] });
      } finally {
        await Promise.all([cb.close().catch(() => {}), ca.close().catch(() => {})]);
      }
      if (++done % 10 === 0) log(`compared ${done}/${tasks.length}`);
    });
    comparisons.sort((x, y) => (x.page < y.page ? -1 : x.page > y.page ? 1 : 0) || x.browser.localeCompare(y.browser) || x.viewport - y.viewport || x.dpr - y.dpr);

    const loads = [...loadProblems].map(([k, problem]) => ({ page: k.split('\u0000')[0]!, problem })).sort((x, y) => (x.page + x.problem < y.page + y.problem ? -1 : 1));
    if (!usedInAfter.size && Object.keys(o.manifest.entries).length) {
      loads.unshift({ page: '*', problem: `the served site loads none of fontphobia's files${site.built ? '' : ' (is it older than `build --write`? pass --rebuild)'}` });
    }
    const ok = !comparisons.some((c) => c.class === 'regression' || c.class === 'failed') && !loads.length && !rejected.length;
    return {
      site: { mode: site.mode, base: site.base, built: site.built }, baseline: baseline ? 'worktree' : 'overlay', browsers: versions, pages, skipped, comparisons,
      bytes: [...bytes.values()].sort((x, y) => (x.page < y.page ? -1 : 1)), loads, rejected, ok, durationMs: Date.now() - t0,
    };
  } finally {
    for (const b of browsers) await b.browser.close().catch(() => {});
    if (linux) { await (await linux.catch(() => undefined))?.stop(); unhook(); }
    await baseline?.stop();
    await site.stop();
  }

  function record(page: string, before: Snapshot['fonts'], after: Snapshot['fonts'], inlined: Set<string>) {
    const row: PageFonts = { page, before: { bytes: 0, requests: 0 }, after: { bytes: 0, requests: 0 }, faces: {} };
    const face = (id: string) => (row.faces[id] ??= { before: 0, after: 0 });
    for (const f of before) {
      if (f.status >= 400) continue;
      row.before.bytes += f.bytes; row.before.requests++;
      const src = overlay.sourceFile(new URL(f.url).pathname);
      // Worktree: the source as the site serves it (bundlers append a hash to the name).
      const name = decodeURIComponent(new URL(f.url).pathname.split('/').pop() ?? '');
      for (const e of Object.values(o.manifest.entries)) {
        const stem = e.source.file.split('/').pop()!.replace(/\.[^.]+$/, '');
        const hit = src ? e.source.sha256 === src.sha256 : name.startsWith(stem);
        if (hit && o.usage.pages[page]?.faces[e.id]) face(e.id).before += f.bytes;
      }
    }
    const loaded = new Set<string>();
    for (const f of after) {
      if (f.status >= 400) { loadProblems.set(`${page}\u0000${f.url}`, `font request failed: HTTP ${f.status} ${f.url}`); continue; }
      row.after.bytes += f.bytes; row.after.requests++;
      for (const ref of overlay.outputsOf(f.url)) {
        loaded.add(ref.entry.id);
        if (o.usage.pages[page]?.faces[ref.entry.id]) face(ref.entry.id).after += f.bytes;
        if (ref.role === 'core') continue;
        // §10.3: an extended or rest file loads only where one of its characters is used.
        const out = ref.entry.outputs.find((x) => x.file === ref.file)!;
        const range = new Set(codePointsOf(parseUnicodeRange(out.unicodeRange)));
        const uses = [...codePointsOf(parseUnicodeRange(o.usage.pages[page]?.faces[ref.entry.id] ?? ''))].some((c) => range.has(c));
        const shared = overlay.outputsOf(f.url).some((r) => [...codePointsOf(parseUnicodeRange(o.usage.pages[page]?.faces[r.entry.id] ?? ''))].some((c) => range.has(c)));
        if (!uses && !shared) loadProblems.set(`${page}\u0000${ref.file}`, `${ref.file} (${ref.role}) loaded, but the page uses none of its characters`);
      }
    }
    // Drawn in the audit, but none of its files loaded and its CSS doesn't name them (inlined data: URLs do): the page doesn't use the build.
    for (const id of Object.keys(o.usage.pages[page]?.faces ?? {})) {
      if (o.manifest.entries[id] && !loaded.has(id) && !inlined.has(id)) loadProblems.set(`${page}\u0000${id}`, `draws ${id} but loaded none of its outputs`);
    }
    bytes.set(page, row);
  }
}

async function compare(
  t: { page: string; viewport: number; dpr: number; engine: Engine },
  base: Comparison,
  b: Awaited<ReturnType<typeof capture>>, a: Awaited<ReturnType<typeof capture>>,
  roundingOk: boolean, manifest: Manifest, outDir: string, ours: Set<string>,
): Promise<Comparison> {
  const B = b.snap, A = a.snap;
  const r: Comparison = { ...base, class: 'identical', nodes: B.nodes.length };
  // Same HTML and JS by construction; if the text differs anyway, the page isn't deterministic.
  const textB = B.nodes.map((n) => n.text).join('\u0000'), textA = A.nodes.map((n) => n.text).join('\u0000');
  if (textB !== textA || B.nodes.length !== A.nodes.length) {
    return { ...r, class: 'content changed', causes: ['the page text differs between two loads (random or time-based content); left out of the result'] };
  }
  let vertical = false, maxDx = 0;
  const moved: number[] = [];
  B.nodes.forEach((nb, i) => {
    const na = A.nodes[i]!;
    let changed = nb.boxes.length !== na.boxes.length;
    if (changed) vertical = true;
    else nb.boxes.forEach((x, k) => {
      const y = na.boxes[k]!;
      const dx = Math.max(Math.abs(x.x - y.x), Math.abs(x.x + x.w - (y.x + y.w)));
      if (dx) { changed = true; maxDx = Math.max(maxDx, dx); }
      if (x.y !== y.y || x.h !== y.h) { changed = true; vertical = true; }
    });
    if (changed) moved.push(i);
  });
  r.moved = moved.length;
  r.maxDx = r2(maxDx);

  // Pixels: compare the common area; a size change is already a layout change.
  const w = Math.min(B.png.width, A.png.width), h = Math.min(B.png.height, A.png.height);
  const crop = (p: PNG) => {
    if (p.width === w && p.height === h) return p.data;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) p.data.copy(out, y * w * 4, y * p.width * 4, y * p.width * 4 + w * 4);
    return out;
  };
  const diff = new PNG({ width: w, height: h });
  r.pixels = pixelmatch(crop(B.png), crop(A.png), diff.data, w, h, { threshold: 0, includeAA: false });
  if (B.png.height !== A.png.height || B.png.width !== A.png.width) vertical = true;

  // Map differing pixels back to text nodes.
  const pixelNodes = new Set<number>();
  if (r.pixels) {
    const hot: [number, number][] = [];
    const step = Math.max(1, t.dpr);
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const k = (y * w + x) * 4;
      if (diff.data[k] === 255 && diff.data[k + 1] === 0 && diff.data[k + 2] === 0) hot.push([x / t.dpr, y / t.dpr]);
      if (hot.length > 20_000) break;
    }
    A.nodes.forEach((n, i) => { if (n.boxes.some((bx) => hot.some(([x, y]) => x >= bx.x - 1 && x <= bx.x + bx.w + 1 && y >= bx.y - 1 && y <= bx.y + bx.h + 1))) pixelNodes.add(i); });
  }
  if (!moved.length && !r.pixels) return r;

  // Name the cause per node: fonts per element on Chromium, then the kind of movement.
  const flagged = [...new Set([...moved, ...pixelNodes])].slice(0, 40);
  // Backend node ids are per page: query each load with its own.
  const ownersOf = (S: Snapshot) => [...new Set(flagged.map((i) => S.nodes[i]!.owner).filter((x): x is number => x !== undefined))];
  const [fb, fa] = await Promise.all([platformFonts(b.cdp, ownersOf(B)), platformFonts(a.cdp, ownersOf(A))]);
  const renames = new Map(Object.values(manifest.entries).filter((e) => e.plan.rename).map((e) => [e.plan.rename!.to, e.plan.rename!.from]));
  // Renamed subsets (OFL Reserved Font Names) report as the new name, or as a named instance of it
  // ("Mrrwthr Subset Light 18pt" for "Merriweather Light 18pt"): map back by prefix.
  const fam = (k: string) => {
    for (const [to, from] of renames) if (k === to || k.startsWith(`${to} `)) return from + k.slice(to.length);
    return k;
  };
  let fallback = false;
  let unrelated = 0;
  for (const i of flagged) {
    const n = A.nodes[i]!;
    const ob = B.nodes[i]!.owner;
    const before = ob !== undefined ? fb.get(ob) : undefined, after = n.owner !== undefined ? fa.get(n.owner) : undefined;
    let cause: string | undefined;
    if (before && after) {
      const names = new Set([...before.keys()].map(fam));
      const extra = [...after].filter(([k]) => !names.has(fam(k)));
      if (extra.length) { cause = `fallback font: ${extra.map(([k, g]) => `${k} drew ${g} glyph(s)`).join(', ')}`; fallback = true; }
    }
    // Same fonts before and after, none of them ours, and the box didn't move: not our doing.
    if (!cause && !moved.includes(i) && before && after && before.size) {
      const names = [...before.keys(), ...after.keys()].map((k) => fam(k).replace(/^system /, '').toLowerCase());
      const same = before.size === after.size && [...before.keys()].every((k) => after.has(k));
      if (same && !names.some((n) => ours.has(n))) { cause = `unrelated: drawn only with ${[...before.keys()].map((k) => k.replace(/^system /, '')).join(', ')}, which fontphobia didn't change`; unrelated++; }
    }
    if (!cause) {
      if (moved.includes(i)) {
        const nb = B.nodes[i]!;
        const linesChanged = nb.boxes.length !== n.boxes.length;
        cause = linesChanged ? `line breaks changed (${nb.boxes.length} → ${n.boxes.length} lines)` : nb.boxes.some((x, k) => x.y !== n.boxes[k]!.y || x.h !== n.boxes[k]!.h) ? 'box height or position changed' : 'width changed (shaping or advance widths)';
      } else cause = 'pixels differ at identical layout (glyph rasterization or sub-pixel glyph positions)';
    }
    if (r.examples.length < 12) r.examples.push({ text: snippet(n.text), cause });
  }
  if (!flagged.length) r.examples.push({ text: '', cause: 'pixels differ outside the text boxes the verifier maps (form controls or replaced content)' });
  r.causes = [...new Set(r.examples.map((x) => x.cause.replace(/\d+ glyph\(s\)/, 'some glyphs')))];

  // §10.3 classification. Rounding: limit-axes only, nothing vertical, under 1 CSS px, and shaping agreed.
  const rounding = !fallback && !vertical && maxDx < 1 && roundingOk && r.causes.every((c) => /^width changed|^pixels differ/.test(c));
  r.class = flagged.length && unrelated === flagged.length && !moved.length ? 'unrelated' : rounding ? 'sub-pixel rounding' : 'regression';
  mkdirSync(outDir, { recursive: true });
  const name = `${slug(t.page)}@${t.viewport}x${t.dpr}.${t.engine}.png`;
  writeFileSync(join(outDir, name), PNG.sync.write(diff));
  r.diffImage = join(outDir, name);
  return r;
}
