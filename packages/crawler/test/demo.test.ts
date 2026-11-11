import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectFont, parseUnicodeRange, type Manifest } from '@fontphobia/core';
import { launchChrome } from '../src/index.ts';
import { serveStatic, type StaticServer } from '../src/serve.ts';
import type { Browser, Page } from 'playwright-core';

const site = new URL('../../../site/', import.meta.url);
const data = JSON.parse(readFileSync(new URL('demo-data.json', site), 'utf8')) as {
  faces: { family: string; source: { url: string; bytes: number; ranges: number[][] }; outputs: { role: string; url: string; bytes: number; ranges: number[][] }[] }[];
};

it('the demo data matches the shipped font manifest and source coverage', async () => {
  const manifest = JSON.parse(readFileSync(new URL('.fontphobia/manifest.json', site), 'utf8')) as Manifest;
  for (const face of data.faces) {
    const entry = Object.values(manifest.entries).find((e) => e.family === face.family)!;
    expect(face.source.url).toBe(entry.source.file);
    const source = await inspectFont(new Uint8Array(readFileSync(new URL(face.source.url, site))));
    expect(face.source.bytes).toBe(source.file.bytes);
    expect(face.source.ranges).toEqual(parseUnicodeRange(source.unicodes.ranges));
    expect(face.outputs).toEqual(entry.outputs.map((o) => ({ role: o.role, url: o.url, bytes: o.bytes, ranges: parseUnicodeRange(o.unicodeRange) })));
    for (const output of face.outputs) expect(statSync(new URL(output.url, site)).size).toBe(output.bytes);
  }
});

let browser: Browser | undefined;
try { browser = await launchChrome(); } catch (e) { if (process.env.CI) throw e; }
let server: StaticServer;
beforeAll(async () => { if (browser) server = await serveStatic(fileURLToPath(site), { base: '/fontphobia/' }); });
afterAll(async () => { await browser?.close(); await server?.close(); });

const content = (page: Page, selector: string) => page.locator(selector).textContent();
const visible = (page: Page, selector: string) => page.locator(selector).isVisible();

describe.skipIf(!browser)('the live font examples', () => {
  it('accounts for the catch-all core file even when text only uses rest or a fallback', async () => {
    const css = readFileSync(new URL('index.html', site), 'utf8').match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const fontRules = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
    for (const [family, sample, roles] of [
      ['Inter', 'A', ['core']],
      ['Inter', 'Ω', ['core', 'rest']],
      ['Inter', '🍞', ['core']],
      ['Fraunces', 'Ω', ['core']],
      ['Fraunces', '€', ['core', 'rest']],
      ['Inter', '', []],
    ] as const) {
      const page = await browser!.newPage();
      try {
        const face = data.faces.find((f) => f.family === family)!;
        const requested: string[] = [];
        page.on('request', (request) => {
          const output = face.outputs.find((o) => new URL(o.url, server.url).href === request.url());
          if (output) requested.push(output.role);
        });
        await page.route('**/font-probe', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><base href="${server.url}"><style>${fontRules}p { font-family: ${family}; }</style><p>${sample}</p>` }));
        await page.goto(new URL('font-probe', server.url).href);
        await page.evaluate(() => document.fonts.ready.then(() => {}));
        expect(requested.sort(), `${family}: ${sample}`).toEqual([...roles].sort());
      } finally { await page.close(); }
    }
  });

  it('routes actual characters, counts each file once, handles empty input and fallback, and fits a phone', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(server.url);
      await page.locator('#font-demo').waitFor({ state: 'visible' });
      const inter = data.faces.find((face) => face.family === 'Inter')!;
      const core = inter.outputs.find((o) => o.role === 'core')!;
      expect(await content(page, '#demo-after')).toBe(`${(core.bytes / 1024).toFixed(1)} KB`);
      await page.locator('#demo-text').fill('aaaa');
      expect(await content(page, '#demo-after')).toBe(`${(core.bytes / 1024).toFixed(1)} KB`);
      await page.getByRole('button', { name: 'Greek', exact: true }).click();
      expect(await content(page, '[data-file="rest"] .file-state')).toBe('Needed');
      await page.locator('#demo-text').fill('Ω');
      const rest = inter.outputs.find((o) => o.role === 'rest')!;
      expect(await content(page, '#demo-after')).toBe(`${((core.bytes + rest.bytes) / 1024).toFixed(1)} KB`);
      await page.locator('#demo-fraunces').check();
      expect(await visible(page, '#demo-fallback')).toBe(true);
      expect(await content(page, '#demo-fallback')).toContain('not in the original Fraunces');
      await page.locator('#demo-inter').check();
      await page.getByRole('button', { name: 'Emoji', exact: true }).click();
      expect(await content(page, '#demo-fallback')).toContain('🍞 (U+1F35E)');
      await page.locator('#demo-text').fill('<img src=x onerror=alert(1)>');
      expect(await page.locator('#demo-route img').count()).toBe(0);
      await page.locator('#demo-text').fill('');
      expect(await content(page, '#demo-total')).toContain('0 files · 0.0 KB');
      await page.locator('#demo-text').fill('A'.repeat(160));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.setViewportSize({ width: 320, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('loads the original only on request and updates both real fonts with keyboard controls', async () => {
    const page = await browser!.newPage();
    try {
      const sources = data.faces.map((face) => new URL(face.source.url, server.url).href);
      const requested: string[] = [];
      page.on('request', (request) => { if (sources.includes(request.url())) requested.push(request.url()); });
      await page.goto(server.url);
      await page.locator('#font-demo').waitFor({ state: 'visible' });
      expect(requested).toEqual([]);
      const summary = page.locator('#demo-comparison > summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      await page.locator('#compare-previews').waitFor({ state: 'visible' });
      expect(requested).toEqual([sources.find((url) => url.includes('InterVariable.woff2'))]);
      expect(await page.locator('#preview-original').evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Inter Original');
      expect(await page.evaluate(() => document.fonts.check('400 32px "Inter Original"'))).toBe(true);
      await page.locator('#demo-weight').focus();
      await page.keyboard.press('ArrowRight');
      expect(await content(page, '#weight-value')).toBe('450');
      expect(await page.locator('#preview-split').evaluate((node) => getComputedStyle(node).fontWeight)).toBe('450');
      await page.locator('#demo-size').focus();
      await page.keyboard.press('End');
      expect(await content(page, '#size-value')).toBe('64 px');
      await page.locator('#demo-text').fill('New text');
      await page.locator('#compare-previews').waitFor({ state: 'visible' });
      expect(await content(page, '#preview-original')).toBe('New text');
      expect(await content(page, '#preview-split')).toBe('New text');
      await page.locator('#demo-fraunces').check();
      await page.locator('#compare-previews').waitFor({ state: 'visible' });
      expect(await page.locator('#preview-original').evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Fraunces Original');
      expect(requested).toHaveLength(2);
    } finally { await page.close(); }
  });

  it('keeps the walkthrough available without JavaScript or demo data', async () => {
    const context = await browser!.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(server.url);
      expect(await visible(page, '#font-demo')).toBe(false);
      expect(await visible(page, '#demo-message')).toBe(true);
      expect(await visible(page, '#walkthrough')).toBe(true);
    } finally { await context.close(); }
    const page = await browser!.newPage();
    try {
      await page.route('**/demo-data.json', (route) => route.fulfill({ status: 500, body: '' }));
      await page.goto(server.url);
      await page.waitForFunction(() => document.querySelector('#demo-message')?.textContent?.includes('could not load'));
      expect(await visible(page, '#font-demo')).toBe(false);
      expect(await visible(page, '#walkthrough')).toBe(true);
    } finally { await page.close(); }
  });
});
