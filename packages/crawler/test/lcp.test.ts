// What a visit records as the largest contentful paint: text, or an image. `auto --allow
// inline-core` gives fonts a large allowance only when every page's largest paint is text.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { Browser } from 'playwright-core';
import { launchChrome, serveStatic, visitPage, type StaticServer } from '../src/index.ts';

let browser: Browser | undefined;
try {
  browser = await launchChrome();
} catch (error) {
  if (process.env.CI) throw error;
}
const dir = mkdtempSync(join(tmpdir(), 'fontphobia-lcp-'));
let server: StaticServer;
beforeAll(async () => {
  const photo = new PNG({ width: 800, height: 600 });
  photo.data.fill(180);
  writeFileSync(join(dir, 'photo.png'), PNG.sync.write(photo));
  const page = (body: string) =>
    `<!doctype html><meta charset="utf-8"><title>t</title><body style="margin:0">${body}</body>`;
  writeFileSync(
    join(dir, 'text.html'),
    page('<h1 style="font-size:64px">A heading that fills the screen</h1><p>Text.</p>'),
  );
  writeFileSync(
    join(dir, 'image.html'),
    page('<img src="photo.png" width="800" height="600" style="width:100%;height:auto"><p>Text.</p>'),
  );
  if (browser) server = await serveStatic(dir);
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!browser)('largest contentful paint', () => {
  it('is text on a page led by a heading, and an image on one led by a photo', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const at = async (name: string) =>
        (await visitPage(ctx, `${server.url}${name}`, { viewport: 390, fontSize: 16, locales: [] })).visit?.lcp;
      expect(await at('text.html')).toBe('text');
      expect(await at('image.html')).toBe('image');
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('falls back to the layout when Chrome reports no entry', async () => {
    const ctx = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    // As on the macOS CI runners: no largest-contentful-paint entry at all.
    await ctx.addInitScript(() => {
      const observe = PerformanceObserver.prototype.observe;
      PerformanceObserver.prototype.observe = function (o?: PerformanceObserverInit) {
        if (o?.type === 'largest-contentful-paint') throw new TypeError('not supported');
        return observe.call(this, o);
      };
    });
    try {
      const at = async (name: string) =>
        (await visitPage(ctx, `${server.url}${name}`, { viewport: 390, fontSize: 16, locales: [] })).visit?.lcp;
      expect(await at('text.html')).toBe('text');
      expect(await at('image.html')).toBe('image');
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
