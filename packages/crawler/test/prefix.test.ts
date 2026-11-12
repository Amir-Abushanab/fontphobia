// A site served under a path prefix (GitHub Pages project sites: https://user.github.io/repo/): page
// keys carry the prefix, seeds and keys resolve under it once, globs match with or without it.
// The crawl and verify tests need Google Chrome.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProject, globToRegExp, type UsageFileJson } from '@fontphobia/core';
import {
  audit,
  launchChrome,
  matchesPage,
  pageKey,
  pageUrl,
  serveStatic,
  sitePath,
  underBase,
  verify,
  type StaticServer,
} from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-prefix-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('pageUrl: page keys and seeds under a base path', () => {
  const sub = 'https://h.example/fontphobia/';
  const root = 'http://127.0.0.1:4173/';
  it('takes a key with the base path as it is and puts any other under the base path', () => {
    expect(pageUrl('/', sub)).toBe(sub);
    expect(pageUrl('/fontphobia/', sub)).toBe(sub);
    expect(pageUrl('/fontphobia', sub)).toBe('https://h.example/fontphobia');
    expect(pageUrl('/fontphobia/bakery/before/', sub)).toBe('https://h.example/fontphobia/bakery/before/');
    expect(pageUrl('/about/', sub)).toBe('https://h.example/fontphobia/about/');
    expect(pageUrl('about', sub)).toBe('https://h.example/fontphobia/about');
    expect(pageUrl('/fontphobiax/', sub)).toBe('https://h.example/fontphobia/fontphobiax/');
    expect(pageUrl('/a/?q=1&b=2', sub)).toBe('https://h.example/fontphobia/a/?q=1&b=2');
    expect(pageUrl('/fontphobia/a/?q=1', sub)).toBe('https://h.example/fontphobia/a/?q=1');
    expect(pageUrl('/about/', root)).toBe('http://127.0.0.1:4173/about/');
    expect(pageUrl('/', root)).toBe(root);
  });

  it('never reads a scheme or another host out of a path', () => {
    for (const [base, pre] of [
      [sub, 'https://h.example/fontphobia'],
      [root, 'http://127.0.0.1:4173'],
    ] as const) {
      expect(pageUrl('/Special:Search', base)).toBe(`${pre}/Special:Search`);
      expect(pageUrl('/std::vector', base)).toBe(`${pre}/std::vector`);
      expect(pageUrl('/https://example.org/x', base)).toBe(`${pre}/https://example.org/x`);
      expect(pageUrl('/javascript:void(0)', base)).toBe(`${pre}/javascript:void(0)`);
      expect(pageUrl('//example.org/x', base)).toBe(`${pre}/example.org/x`);
      expect(pageUrl('/\\example.org/x', base)).toBe(`${pre}/example.org/x`);
    }
  });

  it('round-trips the keys the browser reports', () => {
    for (const u of [
      'https://h.example/fontphobia/',
      'https://h.example/fontphobia/Special:Notes/',
      'https://h.example/fontphobia/a%20b/?x=%C3%A9',
    ])
      expect(pageUrl(pageKey(u), sub)).toBe(u);
    for (const u of ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/Special:Notes/', 'http://127.0.0.1:4173/a?x=1'])
      expect(pageUrl(pageKey(u), root)).toBe(u);
  });

  it('matches globs by the full path or the path under the base, and knows what is outside the base', () => {
    expect(sitePath('/fontphobia/bakery/before/', sub)).toBe('/bakery/before/');
    expect(sitePath('/fontphobia', sub)).toBe('/');
    expect(sitePath('/fontphobia?x=1', sub)).toBe('/?x=1');
    expect(sitePath('/other/', sub)).toBe('/other/');
    expect(sitePath('/bakery/', root)).toBe('/bakery/');
    const bakery = [globToRegExp('/bakery/**')];
    expect(matchesPage(bakery, '/fontphobia/bakery/before/', sub)).toBe(true);
    expect(matchesPage(bakery, '/bakery/before/', root)).toBe(true);
    expect(matchesPage(bakery, '/bakery/before/', sub)).toBe(true); // a usage.json recorded at the root
    expect(matchesPage(bakery, '/fontphobia/about/', sub)).toBe(false);
    expect(matchesPage([globToRegExp('/fontphobia/bakery/**')], '/fontphobia/bakery/x/', sub)).toBe(true);
    expect(underBase('/fontphobia/x/', sub)).toBe(true);
    expect(underBase('/fontphobia', sub)).toBe(true);
    expect(underBase('/fontphobiax/', sub)).toBe(false);
    expect(underBase('/other/', sub)).toBe(false);
    expect(underBase('/anything/', root)).toBe(true);
  });
});

let chrome = true;
try {
  await (await launchChrome()).close();
} catch (e) {
  if (process.env.CI) throw e;
  chrome = false;
}

const page = (
  title: string,
  links: string[],
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>@font-face { font-family: Inter; src: url("/sub/fonts/InterVariable.ttf"); } body { font-family: Inter, sans-serif; }</style></head>
<body><h1>${title}</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}</body></html>`;

describe.skipIf(!chrome)('audit and verify of a site served under /sub/', () => {
  const site = join(tmp, 'site');
  // A file name can't contain ':' on Windows, so the page with one is left out there (the pageUrl tests above cover such paths everywhere).
  const colon = process.platform === 'win32' ? [] : ['Special:Notes'];
  const files: Record<string, string> = {
    'index.html': page('Home', [
      './about/',
      'about/team/',
      ...colon.map((d) => `./${d}/`),
      'bakery/a/',
      '/elsewhere/',
      '/sub/about/',
    ]),
    'about/index.html': page('About us', ['../', 'team/']),
    'about/team/index.html': page('The team', ['../../']),
    ...Object.fromEntries(colon.map((d) => [`${d}/index.html`, page('Special notes', ['../'])])),
    'bakery/a/index.html': page('Bakery A', ['../../']),
    // Served (the server falls back to the root for paths outside /sub/), but another site's page.
    'elsewhere/index.html': page('Elsewhere', []),
  };
  let server: StaticServer;
  const logs: string[] = [];
  beforeAll(async () => {
    for (const [f, html] of Object.entries(files)) {
      mkdirSync(dirname(join(site, f)), { recursive: true });
      writeFileSync(join(site, f), html);
    }
    mkdirSync(join(site, 'fonts'));
    cpSync(join(repo, 'fixtures/fonts/InterVariable.ttf'), join(site, 'fonts/InterVariable.ttf'));
    server = await serveStatic(site, { base: '/sub/' });
  });
  afterAll(async () => {
    await server?.close();
  });
  const opts = () => ({
    root: site,
    url: server.url,
    fontphobiaVersion: 'test',
    viewports: [1280],
    fontSizeSweep: false,
    cache: false,
    log: (m: string) => logs.push(m),
  });

  it('visits every page once, keys them with the prefix, and skips links outside it', async () => {
    const r = await audit({ ...opts(), ignore: ['/bakery/**'] });
    expect(r.crawl.failed).toEqual({});
    expect(r.crawl.pages).toEqual(['/sub/', ...colon.map((d) => `/sub/${d}/`), '/sub/about/', '/sub/about/team/']);
    expect(Object.keys(r.usage.pages).toSorted()).toEqual(r.crawl.pages);
    expect(r.crawl.visits).toBe(3 + colon.length);
  }, 120_000);

  it('matches page globs and config pages written without the prefix, and logs failed visits', async () => {
    logs.length = 0;
    const r = await audit({ ...opts(), pages: ['/', '/about/**', '/missing/'] });
    expect(r.crawl.pages).toEqual(['/sub/', '/sub/about/', '/sub/about/team/']);
    expect(r.crawl.failed).toEqual({ '/sub/missing/': 'HTTP 404' });
    expect(logs).toContainEqual(
      expect.stringMatching(/^pages: \d+ \(\d+ more found, 1 failed: \/sub\/missing\/ HTTP 404\)$/),
    );
  }, 120_000);
});

describe.skipIf(!chrome)('verify against a --url with a path', () => {
  const usage = JSON.parse(readFileSync(join(repo, 'fixtures/plans/static-css/usage.json'), 'utf8')) as UsageFileJson;
  const root = join(tmp, 'static-css');
  let server: StaticServer;
  beforeAll(async () => {
    cpSync(join(repo, 'fixtures/sites/static-css'), root, { recursive: true });
    mkdirSync(join(root, 'fonts'));
    for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2'])
      cpSync(join(repo, 'fixtures/fonts', f), join(root, 'fonts', f));
    await buildProject(root, usage, {}, { version: '1', write: true });
    server = await serveStatic(root, { base: '/sub/' });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
  });
  const loaded = (r: Awaited<ReturnType<typeof verify>>) =>
    r
      .browser!.comparisons.map(
        (c) => `${c.page} ${c.class === 'failed' ? `failed: ${c.causes.join('; ')}` : 'loaded'}`,
      )
      .toSorted();

  it('verifies a usage.json recorded under the same prefix', async () => {
    const prefixed: UsageFileJson = {
      ...usage,
      pages: Object.fromEntries(Object.entries(usage.pages).map(([k, v]) => [`/sub${k}`, v])),
    };
    const r = await verify({
      root,
      usage: prefixed,
      url: server.url,
      viewports: [1280],
      dprs: [1],
      ignore: ['/edge.html'],
      pages: ['/about/'],
    });
    expect(loaded(r)).toEqual(['/sub/ loaded', '/sub/about/ loaded']);
  }, 300_000);

  it('verifies a usage.json recorded at the root', async () => {
    const r = await verify({ root, usage, url: server.url, viewports: [1280], dprs: [1], ignore: ['/edge.html'] });
    expect(loaded(r)).toEqual(['/ loaded', '/about/ loaded']);
  }, 300_000);
});
