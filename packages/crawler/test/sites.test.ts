// M2 acceptance: the Astro and TanStack Start fixtures are built and crawled with no config, and
// TanStack's SSR-only route is crawled in server mode. M4–M5: build --write, verify, revert. Opt-in: FONTPHOBIA_SITES=1, after
// `pnpm install` in each fixture (the `sites` CI job does both).
// First: it has to be in place before playwright-core loads.
import { startGoogleReplay, type GoogleReplay } from './google-replay.ts';
import { constants, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildProject,
  checkProject,
  codePointsOf,
  parseUnicodeRange,
  revertProject,
  type UsageFileJson,
} from '@fontphobia/core';
import { audit, runCommand, verify } from '../src/index.ts';
import { writeGoldenUsage } from './golden.ts';

const sites = fileURLToPath(new URL('../../../fixtures/sites/', import.meta.url));
const enabled = !!process.env.FONTPHOBIA_SITES;
const liveGoogle = !!process.env.FONTPHOBIA_LIVE_GOOGLE;
// CI uploads diff images of failing comparisons from here.
const outDir = (name: string) => (process.env.VERIFY_ARTIFACTS ? join(process.env.VERIFY_ARTIFACTS, name) : undefined);

type Face = {
  family: string;
  chars: string;
  source: { adapter: string; file?: string; line?: number };
  pages: string[];
};
const chars = (r: string) => new Set([...codePointsOf(parseUnicodeRange(r))].map((c) => String.fromCodePoint(c)));

function expectFixtureUsage(faces: Record<string, Face>, cssFile: string) {
  const list = Object.values(faces);
  const css = list.find((f) => f.family === 'Fixture Sans')!;
  expect(css.source).toMatchObject({ adapter: 'css', file: cssFile, line: 2 });
  expect([...chars(css.chars)].toSorted().join('')).toBe(' 24;=cnostx'); // <code>const x = 42;</code>
  const inter = list.filter((f) => f.family === 'Inter Variable');
  expect(inter.map((f) => f.source.adapter)).toEqual(['fontsource', 'fontsource']);
  // Țară needs the latin-ext slice; nothing else on the site does.
  const ext = inter.find((f) => chars(f.chars).has('Ț'))!;
  expect([...chars(ext.chars)].toSorted().join('')).toBe('ăȚ');
  expect(ext.pages).toEqual(['/']);
  expect(list.find((f) => f.family === 'Fraunces')!.source.adapter).toBe('google-fonts');
}

describe.skipIf(!enabled)('framework fixtures, no config', () => {
  // Google Fonts is a local stand-in serving fixtures/google-fonts/ (see google-replay.ts): the
  // fixtures' Google stylesheet and its files load the same way on every run. FONTPHOBIA_LIVE_GOOGLE=1
  // leaves the real Google in place; the scheduled `Live Google Fonts` workflow runs the self-host and
  // tighten tests that way, to notice when Google changes what it serves.
  let google: GoogleReplay | undefined;
  beforeAll(async () => {
    if (!liveGoogle) google = await startGoogleReplay();
  });
  afterEach(() => {
    expect(google?.misses.splice(0) ?? [], 'Google Fonts URLs with no recording in fixtures/google-fonts').toEqual([]);
  });
  afterAll(() => google?.close());

  for (const name of ['astro', 'tanstack-start']) {
    const root = join(sites, name);
    it(`${name}: builds, finds the output and crawls every page`, async () => {
      if (!existsSync(join(root, 'node_modules'))) throw new Error(`run pnpm install in fixtures/sites/${name} first`);
      rmSync(join(root, 'dist'), { recursive: true, force: true });
      const r = await audit({ root, fontphobiaVersion: 'test', fontSizeSweep: false });
      expect(r.crawl.built).toBe('pnpm run build');
      expect(r.crawl).toMatchObject({
        framework: { id: name },
        mode: 'static',
        source: name === 'astro' ? 'dist' : 'dist/client',
        dynamicRoutes: [],
        failed: {},
      });
      expect(r.crawl.pages).toEqual(['/', '/about/', '/posts/1/', '/posts/2/']);
      expectFixtureUsage(
        r.usage.faces as unknown as Record<string, Face>,
        name === 'astro' ? 'src/styles/fonts.css' : 'src/styles.css',
      );
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
        expect(readFileSync(importerFile, 'utf8')).toMatch(
          /import '\.\.\/styles\/fontphobia\/fontsource-variable-inter\.css'/,
        );
        const r2 = await audit(opts); // rebuilds the site with the edited CSS
        const u2 = r2.usage as unknown as UsageFileJson;
        const id = Object.keys(u1.faces).find((k) => u1.faces[k]!.family === 'Fixture Sans')!;
        expect(u2.faces[id]!.chars).toBe(u1.faces[id]!.chars);
        const served = Object.values(u2.pages).flatMap((p) => p.fonts.filter((f) => f.faces.includes(id)));
        expect(served.length).toBeGreaterThan(0);
        for (const f of served) {
          expect(f.status).toBe(200);
          expect(f.url).toMatch(/dejavu-sans-latin\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/);
        }
        // The ejected Inter slices fold back to the same faces, served from the subsets.
        for (const [fid, f] of Object.entries(u1.faces).filter(([, face]) => face.source.adapter === 'fontsource')) {
          expect(u2.faces[fid]?.chars, fid).toBe(f.chars);
          expect(u2.faces[fid]!.files.every((x) => /\.(core|rest)\.[0-9a-f]{8}/.test(x.url))).toBe(true);
        }
        expect((await buildProject(root, u2, {}, { version: 'test' })).unchanged).toBe(true);
        // M5: the built site renders exactly as with the original font, page by page.
        const v = await verify({
          root,
          usage: u1,
          viewports: [1280],
          dprs: [1, 2],
          outDir: outDir(root.split('/').pop()! + '-' + Date.now()),
        });
        expect(v.static.findings).toEqual([]);
        expect(v.browser!.loads).toEqual([]);
        // Every page draws a generated face now (Inter is ejected too).
        expect(v.browser!.pages).toEqual(Object.keys(u1.pages).toSorted());
        expect(v.browser!.comparisons.length).toBe(2 * v.browser!.pages.length);
        expect(
          v
            .browser!.comparisons.filter(
              (c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky',
            )
            .map(
              (c) =>
                `${c.page} DPR ${c.dpr} ${c.class}: ${c.causes.join('; ')} ${JSON.stringify(c.examples.slice(0, 4))}`,
            ),
        ).toEqual([]);
        expect(v.ok).toBe(true);

        // An updated fontsource package makes the ejected copy out of date.
        const mf = join(root, '.fontphobia', 'manifest.json');
        const mText = readFileSync(mf, 'utf8');
        writeFileSync(
          mf,
          mText.replace(/("specifier": "@fontsource-variable\/inter",\s*\n\s*)?"version": "5\.3\.0"/, (m) =>
            m.replace('5.3.0', '5.0.0'),
          ),
        );
        expect((await checkProject({ root, usage: u1 })).issues.map((i) => i.message)).toContainEqual(
          expect.stringMatching(
            /^@fontsource-variable\/inter is 5\.3\.0 now; src\/styles\/fontphobia\/fontsource-variable-inter\.css was ejected from 5\.0\.0$/,
          ),
        );
        writeFileSync(mf, mText);

        // M6: check after the HTML exists passes now, and catches new content. Astro runs it in
        // astro:build:done through fontphobia/astro; TanStack Start (no hook) as a postbuild step.
        const page = join(root, name === 'astro' ? 'src/pages/index.astro' : 'src/routes/index.tsx');
        const pageText = readFileSync(page, 'utf8');
        const config = join(root, 'astro.config.mjs');
        const configText = name === 'astro' ? readFileSync(config, 'utf8') : '';
        try {
          const withIntegration = (args: string) =>
            writeFileSync(
              config,
              `import { defineConfig } from 'astro/config';\nimport fontphobia from ${JSON.stringify(fileURLToPath(new URL('../../cli/src/astro.ts', import.meta.url)))};\nexport default defineConfig({ integrations: [fontphobia(${args})] });\n`,
            );
          if (name === 'astro') {
            withIntegration('');
            const ok = await runCommand('pnpm run build', root);
            expect(ok.output).toMatch(/subsets are up to date/);
            expect(ok.code).toBe(0);
          } else expect((await checkProject({ root, usage: u1 })).issues).toEqual([]);
          // A bullet in the code sample: Fixture Sans has it only in its rest file. It still renders,
          // so the build warns; with strict it fails.
          writeFileSync(page, pageText.replace('const x = 42;', 'const x = 42; •'));
          if (name === 'astro') {
            const warned = await runCommand('pnpm run build', root);
            expect(warned.code).toBe(0);
            expect(warned.output).toMatch(/Fixture Sans: • \(U\+2022\) would load the rest file/);
            withIntegration('{ strict: true }');
            const strict = await runCommand('pnpm run build', root);
            expect(strict.code).not.toBe(0);
            expect(strict.output).toMatch(/Fixture Sans: • \(U\+2022\) would load the rest file/);
          } else {
            expect((await runCommand('pnpm run build', root)).code).toBe(0);
            const r = await checkProject({ root, usage: u1 });
            // Static check can't tell which face draws the bullet: Inter (ejected) is on the page too.
            expect(r.issues.map((i) => i.message)).toContainEqual(
              expect.stringMatching(
                /^Fixture Sans: • \(U\+2022\) would load the rest file \(in .*dist\/client\/index\.html/,
              ),
            );
            expect(r.ok).toBe(true);
            expect(r.command).toBe('pnpm dlx fontphobia@test --write');
          }
        } finally {
          writeFileSync(page, pageText);
          if (name === 'astro') writeFileSync(config, configText);
        }
      } finally {
        if (existsSync(join(root, '.fontphobia', 'manifest.json'))) fonts = revertProject(root, { write: true }).fonts;
        for (const f of fonts) rmSync(join(root, f), { force: true });
        rmSync(join(root, 'src/styles/fontphobia'), { recursive: true, force: true });
      }
      expect(readFileSync(cssFile).equals(original)).toBe(true);
      expect(readFileSync(importerFile).equals(importerOriginal)).toBe(true);
      expect(existsSync(join(root, 'src/styles/fontphobia/fontsource-variable-inter.css'))).toBe(false);
      expect(existsSync(join(root, '.fontphobia', 'manifest.json'))).toBe(false);
    }, 600_000);
  }

  // M7, next-font-local (§6.3): the localFont() path points at one subset file per face; Next's
  // fallback face is unchanged; Next renames the file (dots to underscores) and the audit folds it.
  it('next: build --write repoints localFont(), renders identically, check passes, revert is byte-exact', async () => {
    const root = join(sites, 'next');
    if (!existsSync(join(root, 'node_modules'))) throw new Error('run pnpm install in fixtures/sites/next first');
    const fontsJs = join(root, 'app/fonts.js');
    const original = readFileSync(fontsJs);
    const opts = {
      root,
      fontphobiaVersion: 'test',
      fontSizeSweep: false,
      viewports: [1280],
      rebuild: true,
      cache: false,
    };
    const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
    const id = Object.keys(u1.faces).find((k) => u1.faces[k]!.source.adapter === 'next-font-local')!;
    expect(u1.faces[id]!.source).toMatchObject({
      adapter: 'next-font-local',
      file: 'app/fonts.js',
      line: 4,
      fontFile: 'fonts/DejaVuSans.ttf',
    });
    let fonts: string[] = [];
    try {
      const b = await buildProject(root, u1, {}, { version: 'test', write: true });
      expect(b.notWritten).toEqual([]);
      const f = b.plan.faces.find((x) => x.id === id)!;
      expect(f.files!.map((x) => x.role)).toEqual(['core']); // one file per face, no rest
      expect(readFileSync(fontsJs, 'utf8')).toMatch(/src: '\.\.\/fonts\/DejaVuSans\.core\.[0-9a-f]{8}\.woff2'/);
      const u2 = (await audit(opts)).usage as unknown as UsageFileJson;
      expect(u2.faces[id]!.chars).toBe(u1.faces[id]!.chars);
      expect(u2.faces[id]!.files.every((x) => /DejaVuSans_core_[0-9a-f]{8}/.test(x.url))).toBe(true);
      expect((await buildProject(root, u2, {}, { version: 'test' })).unchanged).toBe(true);
      const v = await verify({
        root,
        usage: u1,
        viewports: [1280],
        dprs: [1, 2],
        outDir: outDir(root.split('/').pop()! + '-' + Date.now()),
      });
      expect(v.static.findings).toEqual([]);
      expect(
        v
          .browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky')
          .map((c) => `${c.page} DPR ${c.dpr}: ${c.causes.join('; ')}`),
      ).toEqual([]);
      expect(v.ok).toBe(true);
      expect((await checkProject({ root, usage: u1 })).issues).toEqual([]);
    } finally {
      if (existsSync(join(root, '.fontphobia', 'manifest.json'))) fonts = revertProject(root, { write: true }).fonts;
      for (const x of fonts) rmSync(join(root, x), { force: true });
    }
    expect(readFileSync(fontsJs).equals(original)).toBe(true);
  }, 900_000);

  // M7, next-font-google (§6.4): a copy of the Next fixture in its own git repo, since verify
  // compares against HEAD built in a worktree. Needs the network (Next fetches Lato from Google).
  it('next: narrows a next/font/google weight list, renders identically against HEAD, revert restores the call', async () => {
    const fixture = join(sites, 'next');
    if (!existsSync(join(fixture, 'node_modules'))) throw new Error('run pnpm install in fixtures/sites/next first');
    const root = mkdtempSync(join(tmpdir(), 'fontphobia-next-google-'));
    try {
      cpSync(fixture, root, {
        recursive: true,
        filter: (p) => !/[\\/](node_modules|\.next|out|\.fontphobia)$/.test(p),
      });
      cpSync(join(fixture, 'node_modules'), join(root, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      }); // Turbopack won't follow a link out of the project
      const call = `Lato({ subsets: ['latin'], weight: ['100', '300', '400', '700', '900'] })`;
      writeFileSync(
        join(root, 'app/fonts.js'),
        readFileSync(join(root, 'app/fonts.js'), 'utf8').replace(
          "import localFont from 'next/font/local';",
          `import localFont from 'next/font/local';\nimport { Lato } from 'next/font/google';\n\nexport const lato = ${call};`,
        ),
      );
      writeFileSync(
        join(root, 'app/page.jsx'),
        readFileSync(join(root, 'app/page.jsx'), 'utf8')
          .replace('export default', "import { lato } from './fonts';\n\nexport default")
          .replace('<h1>', '<h1 className={lato.className}>'),
      );
      const sh = async (args: string[]) => {
        const r = await runCommand(`git -c user.email=t@example.com -c user.name=t ${args.join(' ')}`, root);
        if (r.code) throw new Error(r.output);
      };
      await sh(['init', '-q']);
      await sh(['add', '-A']);
      await sh(['commit', '-qm', 'fixture']);
      const opts = {
        root,
        fontphobiaVersion: 'test',
        fontSizeSweep: false,
        viewports: [1280],
        rebuild: true,
        cache: false,
      };
      const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
      expect(
        Object.values(u1.faces)
          .filter((f) => f.source.adapter === 'next-font-google')
          .map((f) => f.family),
      ).toContain('Lato');
      const b = await buildProject(root, u1, { allow: ['tighten'] }, { version: 'test', write: true });
      expect(b.manifest.options).toEqual([
        {
          adapter: 'next-font-google',
          file: 'app/fonts.js',
          family: 'Lato',
          from: call.slice(5, -1),
          to: `{ subsets: ['latin'], weight: ['400', '700', '900'] }`,
          dropped: { weights: [100, 300], axes: [] },
        },
      ]);
      const v = await verify({
        root,
        usage: u1,
        viewports: [1280],
        dprs: [1],
        outDir: outDir('next-google-' + Date.now()),
      });
      expect(v.browser!.baseline).toBe('worktree');
      expect(
        v
          .browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky')
          .map((c) => `${c.page} DPR ${c.dpr}: ${c.causes.join('; ')}`),
      ).toEqual([]);
      expect(v.ok).toBe(true);
      expect((await checkProject({ root, usage: u1 })).issues).toEqual([]);
      expect(revertProject(root, { write: true }).problems).toEqual([]);
      expect(readFileSync(join(root, 'app/fonts.js'), 'utf8')).toContain(`export const lato = ${call};`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);

  // M7, astro-fonts (§6.8): the Astro fixture with a Fonts API family, in its own git repo (verify
  // compares against HEAD built in a worktree). Needs the network (Astro fetches Lato from Google).
  it('astro: preloads only the Fonts API faces pages load, renders identically against HEAD, revert restores the tag', async () => {
    const fixture = join(sites, 'astro');
    const root = mkdtempSync(join(tmpdir(), 'fontphobia-astro-fonts-'));
    try {
      cpSync(fixture, root, {
        recursive: true,
        filter: (p) => !/[\\/](node_modules|dist|\.astro|\.fontphobia)$/.test(p),
      });
      cpSync(join(fixture, 'node_modules'), join(root, 'node_modules'), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      const entry = `{ provider: fontProviders.google(), name: 'Lato', cssVariable: '--font-lato', weights: [100, 300, 400, 700, 900], styles: ['normal'] }`;
      writeFileSync(
        join(root, 'astro.config.mjs'),
        `import { defineConfig, fontProviders } from 'astro/config';\n\nexport default defineConfig({\n  fonts: [${entry}],\n});\n`,
      );
      const layout = join(root, 'src/layouts/Layout.astro');
      writeFileSync(
        layout,
        readFileSync(layout, 'utf8')
          .replace(
            "import '@fontsource-variable/inter';",
            "import { Font } from 'astro:assets';\nimport '@fontsource-variable/inter';",
          )
          .replace('<title>', '<Font cssVariable="--font-lato" preload />\n\t\t<title>')
          .replace('<nav>', '<nav style="font-family: var(--font-lato)">'),
      );
      const sh = async (args: string[]) => {
        const r = await runCommand(`git -c user.email=t@example.com -c user.name=t ${args.join(' ')}`, root);
        if (r.code) throw new Error(r.output);
      };
      writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.astro/\n.fontphobia/\n');
      await sh(['init', '-q']);
      await sh(['add', '-A']);
      await sh(['commit', '-qm', 'fixture']);
      const opts = {
        root,
        fontphobiaVersion: 'test',
        fontSizeSweep: false,
        viewports: [1280],
        rebuild: true,
        cache: false,
      };
      const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
      expect(Object.values(u1.faces).filter((f) => f.source.adapter === 'astro-fonts').length).toBeGreaterThan(0);
      // Default: the weights stay declared; only the preloads narrow to what pages load.
      const b = await buildProject(root, u1, {}, { version: 'test', write: true });
      expect(b.suggestions.map((x) => x.kind === 'options' && x.weights)).toEqual([[100, 300]]);
      expect(b.manifest.options?.map((r) => [r.adapter, r.kind, r.family])).toEqual([
        ['astro-fonts', 'preload', 'Lato'],
      ]);
      expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toContain(entry);
      expect(readFileSync(layout, 'utf8')).toContain(
        `<Font cssVariable="--font-lato" preload={[{ weight: '400', style: 'normal' }]} />`,
      );
      const v = await verify({
        root,
        usage: u1,
        viewports: [1280],
        dprs: [1],
        outDir: outDir('astro-fonts-' + Date.now()),
      });
      expect(v.browser!.baseline).toBe('worktree');
      expect(
        v
          .browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky')
          .map((c) => `${c.page} DPR ${c.dpr}: ${c.causes.join('; ')}`),
      ).toEqual([]);
      expect(v.ok).toBe(true);
      expect((await checkProject({ root, usage: u1 })).issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(revertProject(root, { write: true }).problems).toEqual([]);
      expect(readFileSync(layout, 'utf8')).toContain('<Font cssVariable="--font-lato" preload />');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);

  // M7, eject (§6.4, §6.8): the family moves from the framework to the site, split, with the
  // framework's fallback faces and classes copied as emitted. A copy of the fixture in its own git
  // repo; verify compares against HEAD built in a worktree. Needs the network (Google).
  async function tempRepo(fixture: string, ignore: string[], edit: (root: string) => void): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'fontphobia-eject-'));
    cpSync(join(sites, fixture), root, {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|dist|out|\.next|\.astro|\.nuxt|\.output|\.fontphobia)$/.test(p),
    });
    cpSync(join(sites, fixture, 'node_modules'), join(root, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    edit(root);
    writeFileSync(join(root, '.gitignore'), ignore.map((x) => `${x}\n`).join(''));
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      ['commit', '-qm', 'fixture'],
    ]) {
      const r = await runCommand(`git -c user.email=t@example.com -c user.name=t ${args.join(' ')}`, root);
      if (r.code) throw new Error(r.output);
    }
    return root;
  }
  const ejectRoundTrip = async (root: string, kind: string, files: string[], family = 'Lato') => {
    const original = Object.fromEntries(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
    const opts = {
      root,
      fontphobiaVersion: 'test',
      fontSizeSweep: false,
      viewports: [1280],
      rebuild: true,
      cache: false,
    };
    const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
    const b = await buildProject(root, u1, { allow: ['eject'] }, { version: 'test', write: true });
    expect(b.notWritten).toEqual([]);
    expect(
      Object.values(b.manifest.ejects ?? {})
        .filter((e) => e.kind === kind)
        .map((e) => e.package),
    ).toEqual([family]);
    expect(Object.values(b.manifest.entries).filter((e) => e.adapter === kind).length).toBeGreaterThan(0);
    const v = await verify({
      root,
      usage: u1,
      viewports: [1280],
      dprs: [1],
      outDir: outDir(`${kind}-eject-${Date.now()}`),
    });
    expect(v.browser!.baseline).toBe('worktree');
    expect(
      v
        .browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky')
        .map((c) => `${c.page} DPR ${c.dpr}: ${c.causes.join('; ')}`),
    ).toEqual([]);
    expect(v.ok).toBe(true);
    const u2 = (await audit(opts)).usage as unknown as UsageFileJson;
    const again = await buildProject(root, u2, {}, { version: 'test' });
    expect(again.notWritten).toEqual([]);
    expect(again.unchanged).toBe(true);
    expect((await checkProject({ root, usage: u2 })).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(revertProject(root, { write: true }).problems).toEqual([]);
    for (const f of files) expect(readFileSync(join(root, f), 'utf8')).toBe(original[f]);
  };

  it('next: --allow eject serves a next/font/google family from the site, renders identically against HEAD, revert restores the call', async () => {
    if (!existsSync(join(sites, 'next', 'node_modules')))
      throw new Error('run pnpm install in fixtures/sites/next first');
    const root = await tempRepo('next', ['node_modules/', '.next/', 'out/', '.fontphobia/cache/'], (r) => {
      writeFileSync(
        join(r, 'app/fonts.js'),
        readFileSync(join(r, 'app/fonts.js'), 'utf8').replace(
          "import localFont from 'next/font/local';",
          "import localFont from 'next/font/local';\nimport { Lato } from 'next/font/google';\n\nexport const lato = Lato({ subsets: ['latin'], weight: ['400', '700'], variable: '--font-lato' });",
        ),
      );
      writeFileSync(
        join(r, 'app/page.jsx'),
        readFileSync(join(r, 'app/page.jsx'), 'utf8')
          .replace('export default', "import { lato } from './fonts';\n\nexport default")
          .replace('<h1>', '<h1 className={lato.className}>')
          .replace('<main>', '<main className={lato.variable}>'),
      );
    });
    try {
      await ejectRoundTrip(root, 'next-font-google', ['app/fonts.js', 'app/page.jsx']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);

  it('astro: --allow eject serves a Fonts API family from the site, renders identically against HEAD, revert restores config and layout', async () => {
    const root = await tempRepo('astro', ['node_modules/', 'dist/', '.astro/', '.fontphobia/cache/'], (r) => {
      writeFileSync(
        join(r, 'astro.config.mjs'),
        `import { defineConfig, fontProviders } from 'astro/config';\n\nexport default defineConfig({\n  fonts: [{ provider: fontProviders.google(), name: 'Lato', cssVariable: '--font-lato', weights: [400, 700], styles: ['normal'] }],\n});\n`,
      );
      const layout = join(r, 'src/layouts/Layout.astro');
      writeFileSync(
        layout,
        readFileSync(layout, 'utf8')
          .replace(
            "import '@fontsource-variable/inter';",
            "import { Font } from 'astro:assets';\nimport '@fontsource-variable/inter';",
          )
          .replace('<title>', '<Font cssVariable="--font-lato" preload />\n\t\t<title>')
          .replace('<nav>', '<nav style="font-family: var(--font-lato)">'),
      );
    });
    try {
      await ejectRoundTrip(root, 'astro-fonts', [
        'astro.config.mjs',
        'src/layouts/Layout.astro',
        'src/styles/fonts.css',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);

  it('nuxt: --allow eject serves a @nuxt/fonts family from the site with its fallback stack, renders identically against HEAD, revert restores config and styles', async () => {
    if (!existsSync(join(sites, 'nuxt', 'node_modules')))
      throw new Error('run pnpm install in fixtures/sites/nuxt first');
    const root = await tempRepo(
      'nuxt',
      ['node_modules/', '.nuxt/', '.output/', 'dist', '.fontphobia/cache/'],
      () => {},
    );
    try {
      // tighten is reported, not applied: Merriweather 300 is listed but nothing asks for it.
      // (Not Lato: @nuxt/fonts lists local() first, and Ubuntu runners have Lato installed.)
      const u = (
        await audit({
          root,
          fontphobiaVersion: 'test',
          fontSizeSweep: false,
          viewports: [1280],
          rebuild: true,
          cache: false,
        })
      ).usage as unknown as UsageFileJson;
      expect(
        (await buildProject(root, u, {}, { version: 'test' })).suggestions.map(
          (x) => x.kind === 'options' && [x.adapter, x.weights],
        ),
      ).toEqual([['nuxt-fonts', [300]]]);
      await ejectRoundTrip(root, 'nuxt-fonts', ['nuxt.config.ts', 'app/app.vue'], 'Merriweather');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 900_000);

  // M7, google-fonts self-host (§6.5). Google's CSS and files come from the recording, so every request
  // for a URL gets the same answer. The real Google sometimes serves a face from an on-the-fly
  // /l/font?kit= URL on one request and the static file on the next, so the first audit can record one
  // face under two ids and pick the one that doesn't survive: retried when live.
  it(
    'astro: --allow self-host serves Fraunces from the site, renders identically, and revert restores the Google link',
    { retry: liveGoogle ? 2 : 0, timeout: 900_000 },
    async () => {
      const root = join(sites, 'astro');
      const layout = join(root, 'src/layouts/Layout.astro');
      const layoutText = readFileSync(layout);
      const opts = {
        root,
        fontphobiaVersion: 'test',
        fontSizeSweep: false,
        viewports: [1280],
        rebuild: true,
        cache: false,
      };
      const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
      const id = Object.keys(u1.faces).find((k) => u1.faces[k]!.family.includes('Fraunces'))!;
      let fonts: string[] = [];
      try {
        const b = await buildProject(root, u1, { allow: ['self-host'] }, { version: 'test', write: true });
        expect(b.notWritten).toEqual([]);
        expect(b.generated.map((g) => g.file)).toContain('public/fonts/fontphobia/google-fraunces.css');
        expect(readFileSync(layout, 'utf8')).toContain('href="/fonts/fontphobia/google-fraunces.css"');
        expect(readFileSync(join(root, `.fontphobia/sources/google/${id}.woff2`)).byteLength).toBeGreaterThan(1000);
        const u2 = (await audit(opts)).usage as unknown as UsageFileJson;
        // Google sometimes serves a face from an on-the-fly /l/font?kit= URL instead (spike 6): say which if the ids differ.
        const fr = (u: UsageFileJson) =>
          Object.entries(u.faces)
            .filter(([k]) => k.startsWith('fraunces'))
            .map(([k, f]) => `${k} ${f.files.map((x) => x.url).join(' ')}`);
        expect(
          Object.keys(u2.faces).filter((k) => k.startsWith('fraunces')),
          `before: ${fr(u1).join('; ')} | after: ${fr(u2).join('; ')}`,
        ).toContain(id);
        expect(u2.faces[id]!.chars).toBe(u1.faces[id]!.chars);
        expect(u2.faces[id]!.files.every((f) => f.url.startsWith('/fonts/fontphobia/'))).toBe(true);
        expect((await buildProject(root, u2, {}, { version: 'test' })).unchanged).toBe(true); // stays self-hosted
        const v = await verify({
          root,
          usage: u1,
          viewports: [1280],
          dprs: [1],
          outDir: outDir(root.split('/').pop()! + '-' + Date.now()),
        });
        expect(
          v
            .browser!.comparisons.filter(
              (c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky',
            )
            .map(
              (c) =>
                `${c.browser} ${c.page} DPR ${c.dpr}: ${c.causes.join('; ')} ${JSON.stringify(c.examples.slice(0, 4))}`,
            ),
        ).toEqual([]);
        expect(v.ok).toBe(true);
      } finally {
        if (existsSync(join(root, '.fontphobia', 'manifest.json'))) fonts = revertProject(root, { write: true }).fonts;
        for (const f of fonts) rmSync(join(root, f), { force: true });
        for (const d of ['src/styles/fontphobia', 'public/fonts/fontphobia', '.fontphobia/sources'])
          rmSync(join(root, d), { recursive: true, force: true });
      }
      expect(readFileSync(layout).equals(layoutText)).toBe(true);
    },
  );

  // M7, google-fonts tighten (§6.5): an unused family in the URL is dropped; verify's "before" loads the original URL.
  it('astro: tighten drops an unused Google family, renders identically, and revert restores the URL', async () => {
    const root = join(sites, 'astro');
    const layout = join(root, 'src/layouts/Layout.astro');
    const layoutText = readFileSync(layout);
    const tight = 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap';
    const loose = tight.replace('&display', '&family=Lora:wght@400;700&display');
    let reverted = '';
    writeFileSync(layout, layoutText.toString('utf8').replace(tight, loose));
    const opts = {
      root,
      fontphobiaVersion: 'test',
      fontSizeSweep: false,
      viewports: [1280],
      rebuild: true,
      cache: false,
    };
    let fonts: string[] = [];
    try {
      const u1 = (await audit(opts)).usage as unknown as UsageFileJson;
      expect(
        (await buildProject(root, u1, {}, { version: 'test' })).suggestions.map(
          (x) => x.kind === 'google' && x.families,
        ),
      ).toEqual([['Lora']]);
      const b = await buildProject(root, u1, { allow: ['tighten'] }, { version: 'test', write: true });
      expect(b.manifest.google).toEqual([
        {
          from: loose,
          to: tight,
          files: ['src/layouts/Layout.astro'],
          dropped: { families: ['Lora'], weights: {}, axes: {} },
        },
      ]);
      expect(readFileSync(layout, 'utf8')).toContain(`href="${tight}"`);
      const u2 = (await audit(opts)).usage as unknown as UsageFileJson;
      expect((await buildProject(root, u2, {}, { version: 'test' })).edits).toEqual([]);
      expect((await checkProject({ root, usage: u2 })).ok).toBe(true);
      const v = await verify({
        root,
        usage: u2,
        viewports: [1280],
        dprs: [1],
        outDir: outDir(root.split('/').pop()! + '-' + Date.now()),
      });
      expect(
        v
          .browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky')
          .map(
            (c) =>
              `${c.browser} ${c.page} DPR ${c.dpr}: ${c.causes.join('; ')} ${JSON.stringify(c.examples.slice(0, 4))}`,
          ),
      ).toEqual([]);
      expect(v.ok).toBe(true);
    } finally {
      if (existsSync(join(root, '.fontphobia', 'manifest.json'))) fonts = revertProject(root, { write: true }).fonts;
      for (const f of fonts) rmSync(join(root, f), { force: true });
      rmSync(join(root, 'src/styles/fontphobia'), { recursive: true, force: true });
      reverted = readFileSync(layout, 'utf8');
      writeFileSync(layout, layoutText); // the fixture is shared: always put it back
    }
    expect(reverted).toContain(`href="${loose}"`);
  }, 900_000);

  it('tanstack-start: crawls an SSR-only route in server mode', async () => {
    const root = join(sites, 'tanstack-start');
    if (!existsSync(join(root, 'dist/server/server.js'))) throw new Error('build fixtures/sites/tanstack-start first');
    const r = await audit({
      root,
      fontphobiaVersion: 'test',
      fontSizeSweep: false,
      viewports: [1280],
      pages: ['/posts/3'],
      startCmd: 'npx --no-install vite preview --port $PORT --strictPort --host 127.0.0.1',
    });
    expect(r.crawl.mode).toBe('server');
    expect(r.crawl.pages).toContain('/posts/3');
    expect(Object.keys(r.usage.pages)).toContain('/posts/3');
  }, 300_000);
});
