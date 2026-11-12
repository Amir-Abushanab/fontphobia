import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAge,
  classifyFace,
  detectCss,
  detectProject,
  findSite,
  globToRegExp,
  htmlPages,
  indexFontFiles,
  routesFromFiles,
  scanOffDom,
} from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const spikes = join(repo, 'spikes/11-frameworks');
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-project-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const write = (root: string, files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
};

describe('framework profiles (§7.1.1)', () => {
  it('detects every spike 11 starter, most specific first', () => {
    const got = Object.fromEntries(
      readdirSync(spikes, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => [e.name, detectProject(join(spikes, e.name)).profile.id]),
    );
    expect(got).toEqual({
      analog: 'analog',
      angular: 'angular',
      astro: 'astro',
      docusaurus: 'docusaurus',
      eleventy: 'eleventy',
      foldkit: 'foldkit',
      gatsby: 'gatsby',
      hugo: 'hugo',
      jekyll: 'jekyll',
      next: 'next',
      nuxt: 'nuxt',
      octane: 'octane',
      qwik: 'qwik',
      'react-router': 'react-router',
      rsbuild: 'rsbuild',
      solidstart: 'solidstart',
      starlight: 'starlight',
      sveltekit: 'sveltekit',
      'tanstack-start': 'tanstack-start',
      'vite-spa': 'vite',
      vitepress: 'vitepress',
    });
  });
  it('notices source files changed after the build', () => {
    const root = write(join(tmp, 'stale'), {
      'package.json': '{"dependencies":{"astro":"7"},"scripts":{"build":"astro build"}}',
      'src/pages/index.astro': '',
      'src/pages/about.astro': '',
      'dist/index.html': '<p>',
      'node_modules/x/index.js': '',
      '.astro/types.d.ts': '',
      'fontphobia.config.ts': '',
    });
    const at = (rel: string, s: number) => utimesSync(join(root, rel), s, s);
    const t = 1_800_000_000;
    for (const f of ['package.json', 'src/pages/index.astro', 'src/pages/about.astro']) at(f, t - 100);
    at('dist/index.html', t);
    for (const f of ['node_modules/x/index.js', '.astro/types.d.ts', 'fontphobia.config.ts']) at(f, t + 500); // not source
    const p = detectProject(root);
    const site = findSite(p)!;
    expect(buildAge(p, site)).toEqual({ builtAt: t * 1000, output: 'dist', newer: undefined });
    at('src/pages/about.astro', t + 300);
    at('src/pages/index.astro', t + 200);
    expect(buildAge(p, site)!.newer).toEqual({ file: 'src/pages/about.astro', mtime: (t + 300) * 1000, count: 2 });
    // The project root as its own output: nothing to compare.
    const flat = write(join(tmp, 'flat'), { 'index.html': '<p>' });
    expect(buildAge(detectProject(flat), findSite(detectProject(flat))!)).toBeUndefined();
  });
  it('picks static output or a server from what the build left', () => {
    const astro = write(join(tmp, 'astro'), {
      'package.json': '{"dependencies":{"astro":"7"}}',
      'dist/index.html': '<p>',
      'dist/about/index.html': '<p>',
    });
    expect(findSite(detectProject(astro))).toMatchObject({ mode: 'static', dir: join(astro, 'dist') });
    write(astro, { 'dist/server/entry.mjs': '', 'dist/client/posts/1/index.html': '<p>' });
    expect(findSite(detectProject(astro))).toMatchObject({
      mode: 'server',
      server: { cmd: 'node dist/server/entry.mjs' },
    });

    const ts = write(join(tmp, 'tanstack'), {
      'package.json': '{"dependencies":{"@tanstack/react-start":"1"}}',
      'dist/client/index.html': '<p>',
      'dist/server/server.js': '',
    });
    expect(findSite(detectProject(ts))).toMatchObject({ mode: 'static', dir: join(ts, 'dist/client') });
    rmSync(join(ts, 'dist/client/index.html'));
    expect(findSite(detectProject(ts))?.server?.cmd).toMatch(/vite preview --port \$PORT/);

    const ng = write(join(tmp, 'ng'), {
      'angular.json': '{}',
      'package.json': '{}',
      'dist/shop/server/server.mjs': '',
      'dist/shop/browser/index.html': '<p>',
    });
    expect(findSite(detectProject(ng))).toMatchObject({
      mode: 'server',
      server: { cmd: 'node dist/shop/server/server.mjs', env: { NG_ALLOWED_HOSTS: 'localhost,127.0.0.1' } },
    });
    expect(
      findSite(detectProject(write(join(tmp, 'empty'), { 'package.json': '{"devDependencies":{"vite":"8"}}' }))),
    ).toBeUndefined();
  });
  it('lists output pages and build route lists', () => {
    const d = write(join(tmp, 'pages'), {
      'index.html': '',
      'about/index.html': '',
      'blog.html': '',
      '_astro/x.html': '',
      '404.html': '',
    });
    expect(htmlPages(d)).toEqual(['/', '/404.html', '/about/', '/blog.html']);
    const ts = write(join(tmp, 'routes'), {
      'package.json': '{"dependencies":{"@tanstack/react-start":"1"}}',
      'src/routeTree.gen.ts': "export interface FileRouteTypes {\n  fullPaths: '/' | '/about' | '/posts/$id'\n}",
    });
    expect(routesFromFiles(detectProject(ts))).toEqual({
      routes: ['/', '/about'],
      dynamic: ['/posts/$id'],
      sources: ['tanstack-route-tree'],
    });
    const nx = write(join(tmp, 'next'), {
      'package.json': '{"dependencies":{"next":"16"}}',
      '.next/prerender-manifest.json': '{"routes":{"/":{},"/blog/a":{}}}',
      '.next/routes-manifest.json':
        '{"staticRoutes":[{"page":"/"},{"page":"/_not-found"}],"dynamicRoutes":[{"page":"/blog/[slug]"}]}',
    });
    expect(routesFromFiles(detectProject(nx))).toEqual({
      routes: ['/', '/blog/a'],
      dynamic: ['/blog/[slug]'],
      sources: ['next-manifest'],
    });
  });
  it('matches globs', () => {
    expect(globToRegExp('/blog/**').test('/blog/a/b')).toBe(true);
    expect(globToRegExp('/blog/*').test('/blog/a/b')).toBe(false);
    expect(globToRegExp('/admin/**').test('/admin/')).toBe(true);
  });
});

describe('css adapter: static scan (§6.1)', () => {
  const site = join(tmp, 'static-css');
  cpSync(join(repo, 'fixtures/sites/static-css'), site, { recursive: true });
  mkdirSync(join(site, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2'])
    cpSync(join(repo, 'fixtures/fonts', f), join(site, 'fonts', f));
  write(site, {
    'src/App.vue':
      '<template/>\n<style>\n@font-face { font-family: Vue; src: url(../fonts/DejaVuSans.ttf); }\n</style>\n',
    'src/theme.scss': '$base: "/fonts";\n@font-face { font-family: S; src: url("#{$base}/x.woff2"); }\n',
    'src/old.sass': '@font-face\n  font-family: Old\n',
    'src/og.tsx': "import { ImageResponse } from 'next/og'\n",
  });
  const css = detectCss(site);
  it('finds declarations in CSS, Sass and component <style> blocks', () => {
    expect(css.map((s) => `${s.file}:${s.line} ${s.rule.family}${s.manual ? ` (${s.manual})` : ''}`)).toEqual([
      'src/App.vue:3 Vue',
      'src/old.sass:1 ? (indented Sass/Stylus)',
      'src/theme.scss:2 S (computed URL)',
      'styles.css:2 Inter',
      'styles.css:9 Inter',
      'styles.css:17 Deja',
      'styles.css:22 Unused',
    ]);
    expect(css.find((s) => s.rule.family === 'Vue')!.files[0]!.path).toBe('fonts/DejaVuSans.ttf');
  });
  it('matches live faces to declarations by bytes and descriptors', () => {
    const index = indexFontFiles(site);
    const inter = css.find((s) => s.rule.family === 'Inter')!.files[0]!.sha256!;
    const live = (style: string) => ({
      family: 'Inter',
      descriptors: { 'font-weight': '100 900', 'font-style': style },
      urls: ['http://x/fonts/InterVariable.ttf'],
      files: new Map([['/fonts/InterVariable.ttf', { sha256: inter }]]),
      local: false,
    });
    expect(classifyFace(live('normal'), css, index)).toMatchObject({
      adapter: 'css',
      file: 'styles.css',
      line: 2,
      fontFile: 'fonts/InterVariable.ttf',
    });
    expect(classifyFace(live('italic'), css, index)).toMatchObject({ adapter: 'css', line: 9 });
    expect(
      classifyFace(
        { family: 'G', descriptors: {}, urls: ['https://fonts.gstatic.com/s/x.woff2'], files: new Map(), local: false },
        css,
        index,
      ).adapter,
    ).toBe('google-fonts');
    expect(
      classifyFace(
        {
          family: 'Inter',
          descriptors: {},
          urls: ['http://x/a.woff2'],
          files: new Map([['/a', { sha256: inter }]]),
          local: false,
        },
        [],
        index,
      ),
    ).toMatchObject({ adapter: 'manual', fontFile: 'fonts/InterVariable.ttf' });
  });
  it('flags fonts used outside the DOM', () => {
    expect(scanOffDom(site)).toEqual([
      { file: 'src/og.tsx', line: 1, kind: 'OG image', text: "import { ImageResponse } from 'next/og'" },
    ]);
  });
});
