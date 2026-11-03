// M2 acceptance: the Astro and TanStack Start fixtures are built and crawled with no config, and
// TanStack's SSR-only route is crawled in server mode. M4–M5: build --write, verify, revert. Opt-in: FONTPHOBIA_SITES=1, after
// `pnpm install` in each fixture (the `sites` CI job does both).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProject, codePointsOf, parseUnicodeRange, revertProject, type UsageFileJson } from '@fontphobia/core';
import { audit, verify } from '../src/index.ts';
import { writeGoldenUsage } from './golden.ts';

const sites = fileURLToPath(new URL('../../../fixtures/sites/', import.meta.url));
const enabled = !!process.env.FONTPHOBIA_SITES;

type Face = { family: string; chars: string; source: { adapter: string; file?: string; line?: number }; pages: string[] };
const chars = (r: string) => new Set([...codePointsOf(parseUnicodeRange(r))].map((c) => String.fromCodePoint(c)));

function expectFixtureUsage(faces: Record<string, Face>, cssFile: string) {
  const list = Object.values(faces);
  const css = list.find((f) => f.family === 'Fixture Sans')!;
  expect(css.source).toMatchObject({ adapter: 'css', file: cssFile, line: 2 });
  expect([...chars(css.chars)].sort().join('')).toBe(' 24;=cnostx'); // <code>const x = 42;</code>
  const inter = list.filter((f) => f.family === 'Inter Variable');
  expect(inter.map((f) => f.source.adapter)).toEqual(['fontsource', 'fontsource']);
  // Țară needs the latin-ext slice; nothing else on the site does.
  const ext = inter.find((f) => chars(f.chars).has('Ț'))!;
  expect([...chars(ext.chars)].sort().join('')).toBe('ăȚ');
  expect(ext.pages).toEqual(['/']);
  expect(list.find((f) => f.family === 'Fraunces')!.source.adapter).toBe('google-fonts');
}

describe.skipIf(!enabled)('framework fixtures, no config', () => {
  for (const name of ['astro', 'tanstack-start']) {
    const root = join(sites, name);
    it(`${name}: builds, finds the output and crawls every page`, async () => {
      if (!existsSync(join(root, 'node_modules'))) throw new Error(`run pnpm install in fixtures/sites/${name} first`);
      rmSync(join(root, 'dist'), { recursive: true, force: true });
      const r = await audit({ root, fontphobiaVersion: 'test', fontSizeSweep: false });
      expect(r.crawl.built).toBe('pnpm run build');
      expect(r.crawl).toMatchObject({ framework: { id: name }, mode: 'static', source: name === 'astro' ? 'dist' : 'dist/client', dynamicRoutes: [], failed: {} });
      expect(r.crawl.pages).toEqual(['/', '/about/', '/posts/1/', '/posts/2/']);
      expectFixtureUsage(r.usage.faces as unknown as Record<string, Face>, name === 'astro' ? 'src/styles/fonts.css' : 'src/styles.css');
      if (process.env.UPDATE_GOLDEN) writeGoldenUsage(name, r.usage);
    }, 300_000);
  }

  for (const name of ['astro', 'tanstack-start']) {
    const root = join(sites, name);
    it(`${name}: build --write, rebuild the site, and it renders from the subsets; revert is byte-exact`, async () => {
      const cssFile = join(root, name === 'astro' ? 'src/styles/fonts.css' : 'src/styles.css');
      const original = readFileSync(cssFile);
      const opts = { root, fontphobiaVersion: 'test', fontSizeSweep: false, viewports: [1280], rebuild: true };
      const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
      let fonts: string[] = [];
      try {
        const b = await buildProject(root, u1, {}, { version: 'test', write: true });
        expect(b.plan.faces.find((f) => f.family === 'Fixture Sans')!.status).toBe('planned');
        expect(b.notWritten.map((n) => n.reason)).toEqual([expect.stringMatching(/fontsource faces arrives in M7/), expect.stringMatching(/fontsource faces arrives in M7/)]);
        const r2 = await audit(opts); // rebuilds the site with the edited CSS
        const u2 = r2.usage as unknown as UsageFileJson;
        const id = Object.keys(u1.faces).find((k) => u1.faces[k]!.family === 'Fixture Sans')!;
        expect(u2.faces[id]!.chars).toBe(u1.faces[id]!.chars);
        const served = Object.values(u2.pages).flatMap((p) => p.fonts.filter((f) => f.faces.includes(id)));
        expect(served.length).toBeGreaterThan(0);
        for (const f of served) { expect(f.status).toBe(200); expect(f.url).toMatch(/dejavu-sans-latin\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/); }
        expect((await buildProject(root, u2, {}, { version: 'test' })).unchanged).toBe(true);
        // M5: the built site renders exactly as with the original font, page by page.
        const v = await verify({ root, usage: u1, viewports: [1280], dprs: [1, 2] });
        expect(v.static.findings).toEqual([]);
        expect(v.browser!.loads).toEqual([]);
        // Only pages that draw a generated face are compared: Fixture Sans is on one page.
        expect(v.browser!.pages).toEqual(u1.faces[id]!.pages);
        expect(v.browser!.comparisons.map((c) => c.class)).toEqual(Array(2 * v.browser!.pages.length).fill('identical'));
        expect(v.ok).toBe(true);
      } finally {
        if (existsSync(join(root, 'fontphobia.manifest.json'))) fonts = revertProject(root, { write: true }).fonts;
        for (const f of fonts) rmSync(join(root, f), { force: true });
      }
      expect(readFileSync(cssFile).equals(original)).toBe(true);
      expect(existsSync(join(root, 'fontphobia.manifest.json'))).toBe(false);
    }, 600_000);
  }

  it('tanstack-start: crawls an SSR-only route in server mode', async () => {
    const root = join(sites, 'tanstack-start');
    if (!existsSync(join(root, 'dist/server/server.js'))) throw new Error('build fixtures/sites/tanstack-start first');
    const r = await audit({ root, fontphobiaVersion: 'test', fontSizeSweep: false, viewports: [1280], pages: ['/posts/3'], startCmd: 'npx --no-install vite preview --port $PORT --strictPort --host 127.0.0.1' });
    expect(r.crawl.mode).toBe('server');
    expect(r.crawl.pages).toContain('/posts/3');
    expect(Object.keys(r.usage.pages)).toContain('/posts/3');
  }, 300_000);
});
