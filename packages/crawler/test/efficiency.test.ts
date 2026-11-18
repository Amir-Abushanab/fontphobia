// The audit's cost savers: the image cache, the per-page visit cache files, cropped diff images,
// and the sampled sweep (which must find what a full sweep finds).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { codePointsOf, parseUnicodeRange } from '@fontphobia/core';
import { audit, cutToDiff, ImageCache, launchChrome, sectionOf, VisitCache } from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-efficiency-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let chrome = true;
try {
  await (await launchChrome()).close();
} catch (e) {
  if (process.env.CI) throw e;
  chrome = false;
}

/** A stand-in for Playwright's Route: records fetches and fulfilments. */
function route(url: string, o: { type?: string; method?: string; fail?: boolean } = {}) {
  const r = {
    fetched: 0,
    fulfilled: undefined as undefined | { status: number; body: Buffer },
    request: () => ({ url: () => url, method: () => o.method ?? 'GET', resourceType: () => o.type ?? 'image' }),
    fetch: async () => {
      r.fetched++;
      if (o.fail) throw new Error('offline');
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'image/png', 'content-length': '3' }),
        body: async () => Buffer.from('png'),
      };
    },
    fulfill: async (x: { status: number; body: Buffer }) => {
      r.fulfilled = x;
    },
  };
  return r;
}

describe('ImageCache', () => {
  it('fetches a remote image once and serves the same response to every later load', async () => {
    const cache = new ImageCache();
    const a = route('https://example.com/favicon.png'),
      b = route('https://example.com/favicon.png');
    expect(await cache.serve(a as never)).toBe(true);
    expect(await cache.serve(b as never)).toBe(true);
    expect(a.fetched + b.fetched).toBe(1);
    expect(b.fulfilled?.body.toString()).toBe('png');
    expect(b.fulfilled?.status).toBe(200);
  });

  it('leaves the local server, other request types, POSTs and Adobe page views alone', async () => {
    const cache = new ImageCache();
    for (const r of [
      route('http://127.0.0.1:4321/a.png'),
      route('http://localhost:4321/a.png'),
      route('https://example.com/app.js', { type: 'script' }),
      route('https://example.com/a.png', { method: 'POST' }),
      route('https://p.typekit.net/p.gif'),
    ]) {
      expect(await cache.serve(r as never)).toBe(false);
      expect(r.fetched).toBe(0);
    }
  });

  it('lets a failed fetch through to the browser and tries again next time', async () => {
    const cache = new ImageCache();
    expect(await cache.serve(route('https://example.com/x.png', { fail: true }) as never)).toBe(false);
    const again = route('https://example.com/x.png');
    expect(await cache.serve(again as never)).toBe(true);
    expect(again.fetched).toBe(1);
  });

  it('stops keeping responses past its byte limit', async () => {
    const cache = new ImageCache(2);
    await cache.serve(route('https://example.com/big.png') as never);
    await new Promise((r) => setTimeout(r, 0));
    const again = route('https://example.com/big.png');
    await cache.serve(again as never);
    expect(again.fetched).toBe(1);
  });
});

describe('VisitCache', () => {
  it('keeps one file per page, and prune drops the settings and pages a run did not use', async () => {
    const root = join(tmp, 'cache');
    mkdirSync(root);
    const cache = new VisitCache(root, { chrome: 'x', fontphobia: 'x', userAgent: 'x', locales: [] });
    const r = (page: string) => ({
      visit: { page } as never,
      resources: [],
      status: 200,
      finalUrl: `http://localhost${page}`,
      links: [],
      bodies: new Map(),
    });
    const k1 = cache.keyOf('http://localhost/a', { viewport: 1280, fontSize: 16 });
    const k2 = cache.keyOf('http://localhost/a', { viewport: 360, fontSize: 16 });
    const k3 = cache.keyOf('http://localhost/b', { viewport: 1280, fontSize: 16 });
    cache.put(k1, 'http://localhost', r('/a'));
    cache.put(k2, 'http://localhost', r('/a'));
    cache.put(k3, 'http://localhost', r('/b'));
    const dir = join(root, '.fontphobia/cache/visits');
    expect(readdirSync(dir)).toHaveLength(2);
    const next = new VisitCache(root, { chrome: 'x', fontphobia: 'x', userAgent: 'x', locales: [] });
    expect((await next.get(k2, 'http://localhost'))?.finalUrl).toBe('http://localhost/a');
    next.prune(); // only k2 was used
    expect(readdirSync(dir)).toHaveLength(1);
    const last = new VisitCache(root, { chrome: 'x', fontphobia: 'x', userAgent: 'x', locales: [] });
    expect(await last.get(k1, 'http://localhost')).toBeUndefined();
    expect(await last.get(k2, 'http://localhost')).toBeDefined();
  });
});

describe('cutToDiff', () => {
  const png = (h: number, red: number[]) => {
    const p = new PNG({ width: 10, height: h });
    p.data.fill(255);
    for (const y of red) for (let x = 0; x < 10; x++) p.data.set([255, 0, 0, 255], (y * 10 + x) * 4);
    return p;
  };
  const row = (p: PNG, y: number) => [...p.data.subarray(y * 40, y * 40 + 4)];
  it('keeps the rows near a difference, cuts the rest, and marks each cut', () => {
    const r = cutToDiff(png(1000, [100, 105, 700]), 10);
    expect(r.bands).toEqual([
      [90, 116],
      [690, 711],
    ]);
    expect(r.png.height).toBe(26 + 2 + 21);
    expect(row(r.png, 10)).toEqual([255, 0, 0, 255]); // row 100
    expect(row(r.png, 26)).toEqual([60, 120, 230, 255]); // the seam
    expect(row(r.png, 28 + 10)).toEqual([255, 0, 0, 255]); // row 700
  });
  it('leaves an image whole when nothing differs, or keeping the rows saves nothing', () => {
    expect(cutToDiff(png(100, []), 10).bands).toBeUndefined();
    expect(cutToDiff(png(100, [10, 30, 50, 70, 90]), 10).bands).toBeUndefined();
  });
});

describe('sampled sweep', () => {
  it('groups pages by parent path and traits', () => {
    const t = { emMq: false, textScale: false, private: false };
    expect(sectionOf('/posts/a/', t)).toBe(sectionOf('/posts/b/', t));
    expect(sectionOf('/posts/a.html', t)).toBe(sectionOf('/posts/b.html', t));
    expect(sectionOf('/posts/', t)).not.toBe(sectionOf('/posts/a/', t));
    expect(sectionOf('/posts/a/', t)).not.toBe(sectionOf('/posts/b/', { ...t, emMq: true }));
    expect(sectionOf('/search?q=1', t)).not.toBe(sectionOf('/search', t));
  });

  it.skipIf(!chrome)(
    'runs a setting on every page of a section when a sample page drew something new with it, and only then',
    async () => {
      const site = join(tmp, 'site');
      mkdirSync(join(site, 'posts'), { recursive: true });
      mkdirSync(join(site, 'notes'), { recursive: true });
      cpSync(join(repo, 'fixtures/fonts/InterVariable.ttf'), join(site, 'Inter.ttf'));
      const css = `@font-face{font-family:Inter;src:url(/Inter.ttf)}body{font-family:Inter}.m{display:none}@media (max-width:500px){.m{display:block}}`;
      const page = (body: string) =>
        `<!doctype html><html lang="en"><head><style>${css}</style></head><body>${body}<a href="/posts/a.html">a</a><a href="/notes/a.html">n</a></body></html>`;
      writeFileSync(join(site, 'index.html'), page('<p>Home</p>'));
      // posts: a phone-only line in Greek on every post (Ω only at 360 px).
      for (const p of ['a', 'b', 'c', 'd'])
        writeFileSync(
          join(site, `posts/${p}.html`),
          page(`<p>Post ${p}</p><p class="m">Ωmega ${p}</p>`) +
            `<a href="/posts/${String.fromCharCode(p.charCodeAt(0) + 1)}.html">next</a>`,
        );
      // notes: nothing that only shows at another width.
      for (const p of ['a', 'b', 'c', 'd'])
        writeFileSync(
          join(site, `notes/${p}.html`),
          page(`<p>Note ${p}</p>`) + `<a href="/notes/${String.fromCharCode(p.charCodeAt(0) + 1)}.html">next</a>`,
        );
      const run = (fullSweep: boolean) =>
        audit({ root: site, dist: '.', fontphobiaVersion: 'test', cache: false, fontSizeSweep: false, fullSweep });
      const [full, sampled] = [await run(true), await run(false)];
      const chars = (u: typeof full.usage, p: string) =>
        new Set(codePointsOf(parseUnicodeRange(Object.values(u.pages[p]!.faces).join(', '))));
      // The third post isn't a sample page, yet it gets the 360 px load that draws its Ω.
      expect(sampled.usage.pages['/posts/c.html']!.visits).toContain('360');
      expect(chars(sampled.usage, '/posts/c.html').has(0x3a9)).toBe(true);
      // Notes past the samples get only their first load.
      expect(sampled.usage.pages['/notes/c.html']!.visits).toEqual(['1280']);
      for (const p of Object.keys(full.usage.pages))
        expect([...chars(sampled.usage, p)].toSorted(), p).toEqual([...chars(full.usage, p)].toSorted());
      expect(sampled.usage.faces).toEqual(full.usage.faces);
      expect(sampled.crawl.sweep?.skipped).toBeGreaterThan(0);
      expect(sampled.crawl.visits).toBeLessThan(full.crawl.visits);
    },
    180_000,
  );
});
