import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChrome, serveStatic, type StaticServer } from '../src/index.ts';
import type { Browser } from 'playwright-core';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
it('publishes exactly the source and generated files that were measured', () => {
  expect(execFileSync(process.execPath, ['scripts/check-bakery.mjs'], { cwd: repo, encoding: 'utf8' })).toContain('match');
});

let browser: Browser | undefined;
try { browser = await launchChrome(); } catch (error) { if (process.env.CI) throw error; }
let server: StaticServer;
beforeAll(async () => { if (browser) server = await serveStatic(fileURLToPath(new URL('../../../site/', import.meta.url)), { base: '/fontphobia/' }); });
afterAll(async () => { await browser?.close(); await server?.close(); });

describe.skipIf(!browser)('published bakery copies', () => {
  it('filters accents, categories and vegan items, and keeps state when switching fonts', async () => {
    for (const mode of ['before', 'after']) {
      const page = await browser!.newPage();
      try {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${server.url}bakery/${mode}/menu.html`);
        await page.locator('#menu-tools').waitFor({ state: 'visible' });
        await page.locator('#menu-search').fill('CREME');
        expect(await page.locator('.menu-item:visible').count()).toBe(1);
        expect(await page.locator('.menu-item:visible').textContent()).toContain('Crème brûlée tart');
        await page.getByRole('button', { name: 'Coffee', exact: true }).click();
        expect(await page.locator('#menu-empty').isVisible()).toBe(true);
        await page.locator('#menu-search').fill('');
        expect(await page.locator('.menu-item:visible').count()).toBe(4);
        await page.getByLabel('Vegan only', { exact: true }).check();
        expect(await page.locator('.menu-item:visible').count()).toBe(2);
        const target = mode === 'before' ? 'after' : 'before';
        await page.getByRole('link', { name: mode === 'before' ? 'Optimized fonts' : 'Original fonts', exact: true }).click();
        expect(new URL(page.url()).pathname).toBe(`/fontphobia/bakery/${target}/menu.html`);
        expect(new URL(page.url()).searchParams.get('category')).toBe('coffee');
        expect(new URL(page.url()).searchParams.get('vegan')).toBe('1');
        await page.locator('#menu-tools').waitFor({ state: 'visible' });
        expect(await page.locator('.menu-item:visible').count()).toBe(2);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  });

  it('serves nested pages and shared photos at phone and desktop sizes', async () => {
    const page = await browser!.newPage();
    try {
      const failed: string[] = [];
      page.on('response', (response) => { if (response.status() >= 400) failed.push(response.url()); });
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of ['', 'menu.html', 'about.html', 'journal/levain.html']) {
          await page.goto(`${server.url}bakery/after/${path}`);
          await page.evaluate(async () => { for (const image of document.images) image.loading = 'eager'; await Promise.all([...document.images].map((image) => image.decode())); await document.fonts.ready; });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} at ${width}px`).toBe(true);
          expect(await page.locator('img').count()).toBeGreaterThan(0);
        }
      }
      await page.getByRole('link', { name: 'Original fonts', exact: true }).click();
      expect(new URL(page.url()).pathname).toBe('/fontphobia/bakery/before/journal/levain.html');
      await page.getByRole('link', { name: 'Measurements & walkthrough', exact: true }).click();
      expect(new URL(page.url()).pathname).toBe('/fontphobia/index.html');
      expect(failed).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('leaves the menu and font-version links usable without JavaScript', async () => {
    const context = await browser!.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(`${server.url}bakery/after/menu.html`);
      expect(await page.locator('.menu-item:visible').count()).toBe(12);
      expect(await page.locator('#menu-tools').isVisible()).toBe(false);
      await page.getByRole('link', { name: 'Original fonts', exact: true }).click();
      expect(new URL(page.url()).pathname).toBe('/fontphobia/bakery/before/menu.html');
    } finally { await context.close(); }
  });
});
