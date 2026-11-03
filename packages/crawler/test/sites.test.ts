// M2 acceptance: the Astro and TanStack Start fixtures are built and crawled with no config, and
// TanStack's SSR-only route is crawled in server mode. M4–M5: build --write, verify, revert. Opt-in: FONTPHOBIA_SITES=1, after
// `pnpm install` in each fixture (the `sites` CI job does both).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProject, checkProject, codePointsOf, parseUnicodeRange, revertProject, type UsageFileJson } from '@fontphobia/core';
import { audit, findRuntime, runCommand, verify } from '../src/index.ts';
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
      const importerFile = join(root, name === 'astro' ? 'src/layouts/Layout.astro' : 'src/routes/__root.tsx');
      const importerOriginal = readFileSync(importerFile);
      const opts = { root, fontphobiaVersion: 'test', fontSizeSweep: false, viewports: [1280], rebuild: true };
      const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
      let fonts: string[] = [];
      try {
        const b = await buildProject(root, u1, {}, { version: 'test', write: true });
        expect(b.plan.faces.find((f) => f.family === 'Fixture Sans')!.status).toBe('planned');
        // M7: fontsource ejected into the project, the import pointed at the copy (§6.2).
        expect(b.notWritten).toEqual([]);
        expect(b.generated.map((g) => g.file)).toEqual(['src/styles/fontphobia/fontsource-variable-inter.css']);
        expect(readFileSync(importerFile, 'utf8')).toMatch(/import '\.\.\/styles\/fontphobia\/fontsource-variable-inter\.css'/);
        const r2 = await audit(opts); // rebuilds the site with the edited CSS
        const u2 = r2.usage as unknown as UsageFileJson;
        const id = Object.keys(u1.faces).find((k) => u1.faces[k]!.family === 'Fixture Sans')!;
        expect(u2.faces[id]!.chars).toBe(u1.faces[id]!.chars);
        const served = Object.values(u2.pages).flatMap((p) => p.fonts.filter((f) => f.faces.includes(id)));
        expect(served.length).toBeGreaterThan(0);
        for (const f of served) { expect(f.status).toBe(200); expect(f.url).toMatch(/dejavu-sans-latin\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/); }
        // The ejected Inter slices fold back to the same faces, served from the subsets.
        for (const [fid, f] of Object.entries(u1.faces).filter(([, f]) => f.source.adapter === 'fontsource')) {
          expect(u2.faces[fid]?.chars, fid).toBe(f.chars);
          expect(u2.faces[fid]!.files.every((x) => /\.(core|rest)\.[0-9a-f]{8}/.test(x.url))).toBe(true);
        }
        expect((await buildProject(root, u2, {}, { version: 'test' })).unchanged).toBe(true);
        // M5: the built site renders exactly as with the original font, page by page. On macOS the
        // comparison runs in the Linux image when it can: CoreText draws some variable composite
        // glyphs from small subsets a few pixels differently (PLAN, M7 notes, open issue).
        const linux = process.platform === 'darwin' && (await findRuntime());
        const v = await verify({ root, usage: u1, viewports: [1280], dprs: [1, 2], browsers: linux ? ['linux-chromium'] : ['chromium'] });
        expect(v.static.findings).toEqual([]);
        expect(v.browser!.loads).toEqual([]);
        // Every page draws a generated face now (Inter is ejected too).
        expect(v.browser!.pages).toEqual(Object.keys(u1.pages).sort());
        expect(v.browser!.comparisons.length).toBe(2 * v.browser!.pages.length);
        expect(v.browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated').map((c) => `${c.page} DPR ${c.dpr} ${c.class}: ${c.causes.join('; ')} ${JSON.stringify(c.examples.slice(0, 4))}`)).toEqual([]);
        expect(v.ok).toBe(true);

        // An updated fontsource package makes the ejected copy out of date.
        const mf = join(root, 'fontphobia.manifest.json');
        const mText = readFileSync(mf, 'utf8');
        writeFileSync(mf, mText.replace(/("specifier": "@fontsource-variable\/inter",\s*\n\s*)?"version": "5\.3\.0"/, (m) => m.replace('5.3.0', '5.0.0')));
        expect((await checkProject({ root, usage: u1 })).issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/^@fontsource-variable\/inter is 5\.3\.0 now; src\/styles\/fontphobia\/fontsource-variable-inter\.css was ejected from 5\.0\.0$/));
        writeFileSync(mf, mText);

        // M6: check after the HTML exists passes now, and catches new content. Astro runs it in
        // astro:build:done through fontphobia/astro; TanStack Start (no hook) as a postbuild step.
        const page = join(root, name === 'astro' ? 'src/pages/index.astro' : 'src/routes/index.tsx');
        const pageText = readFileSync(page, 'utf8');
        const config = join(root, 'astro.config.mjs');
        const configText = name === 'astro' ? readFileSync(config, 'utf8') : '';
        try {
          if (name === 'astro') {
            writeFileSync(config, `import { defineConfig } from 'astro/config';\nimport fontphobia from ${JSON.stringify(fileURLToPath(new URL('../../cli/src/astro.ts', import.meta.url)))};\nexport default defineConfig({ integrations: [fontphobia()] });\n`);
            const ok = await runCommand('pnpm run build', root);
            expect(ok.output).toMatch(/subsets are up to date/);
            expect(ok.code).toBe(0);
          } else expect((await checkProject({ root, usage: u1 })).issues).toEqual([]);
          // A bullet in the code sample: Fixture Sans has it only in its rest file.
          writeFileSync(page, pageText.replace('const x = 42;', 'const x = 42; •'));
          if (name === 'astro') {
            const stale = await runCommand('pnpm run build', root);
            expect(stale.code).not.toBe(0);
            expect(stale.output).toMatch(/Fixture Sans: • \(U\+2022\) would load the rest file/);
          } else {
            expect((await runCommand('pnpm run build', root)).code).toBe(0);
            const r = await checkProject({ root, usage: u1 });
            // Static check can't tell which face draws the bullet: Inter (ejected) is on the page too.
            expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/^Fixture Sans: • \(U\+2022\) would load the rest file \(in .*dist\/client\/index\.html/));
            expect(r.command).toBe('pnpm dlx fontphobia@test --write');
          }
        } finally {
          writeFileSync(page, pageText);
          if (name === 'astro') writeFileSync(config, configText);
        }
      } finally {
        if (existsSync(join(root, 'fontphobia.manifest.json'))) fonts = revertProject(root, { write: true }).fonts;
        for (const f of fonts) rmSync(join(root, f), { force: true });
        rmSync(join(root, 'src/styles/fontphobia'), { recursive: true, force: true });
      }
      expect(readFileSync(cssFile).equals(original)).toBe(true);
      expect(readFileSync(importerFile).equals(importerOriginal)).toBe(true);
      expect(existsSync(join(root, 'src/styles/fontphobia/fontsource-variable-inter.css'))).toBe(false);
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
