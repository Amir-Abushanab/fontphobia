// M5 acceptance for the browser layer of verify (§10.3) on the static `css` fixture: a clean build is
// pixel-identical to the original fonts at every viewport and DPR, and each mutation (§15) fails with
// the right cause. Needs Google Chrome.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProject, createOverlay, parseStylesheet, readManifest, type Mutation, type UsageFileJson } from '@fontphobia/core';
import { findRuntime, formatVerify, launchChrome, verify, verifyMarkdown } from '../src/index.ts';
import { firefox, webkit } from 'playwright-core';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-verify-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const usage = JSON.parse(readFileSync(join(repo, 'fixtures/plans/static-css/usage.json'), 'utf8')) as UsageFileJson;

let chrome = true;
try { await (await launchChrome()).close(); } catch (e) {
  if (process.env.CI) throw e;
  chrome = false;
}

const starts = async (t: typeof webkit) => { try { await (await t.launch()).close(); return true; } catch { return false; } };
const hostEngines = { webkit: await starts(webkit), firefox: await starts(firefox) };
// Linux engines need a container runtime (Apple container, Docker or Podman); CI's sites job has Docker.
const runtime = chrome && (process.env.FONTPHOBIA_LINUX || !process.env.CI) ? await findRuntime() : undefined;

// CI uploads diff images of failing comparisons from here.
const outDir = (name: string) => (process.env.VERIFY_ARTIFACTS ? join(process.env.VERIFY_ARTIFACTS, name) : undefined);
const differences = (r: Awaited<ReturnType<typeof verify>>) => r.browser!.comparisons.filter((c) => c.class !== 'identical' && c.class !== 'unrelated' && c.class !== 'flaky')
  .map((c) => `${c.browser} ${c.page} ${c.viewport} DPR ${c.dpr} ${c.class} ${c.pixels}px: ${c.causes.join('; ')} ${JSON.stringify(c.examples.slice(0, 4))}`);

function copy(name: string) {
  const root = join(tmp, name);
  cpSync(join(repo, 'fixtures/sites/static-css'), root, { recursive: true });
  mkdirSync(join(root, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) cpSync(join(repo, 'fixtures/fonts', f), join(root, 'fonts', f));
  return root;
}
async function built(name: string, mutation?: Mutation) {
  const root = copy(name);
  await buildProject(root, usage, { mutation }, { version: '1', write: true });
  return root;
}

describe('overlay (§10.3): the built CSS and HTML with the original fonts swapped back', () => {
  it('restores each generated block to the original rule and points preloads at the source', async () => {
    const root = await built('overlay');
    const o = createOverlay(readManifest(root)!);
    const css = o.restoreCss(readFileSync(join(root, 'styles.css'), 'utf8'))!;
    const original = parseStylesheet(readFileSync(join(repo, 'fixtures/sites/static-css/styles.css'), 'utf8')).fontFaces;
    const restored = parseStylesheet(css).fontFaces;
    expect(restored.map((f) => [f.family, f.descriptors['font-style']])).toEqual(original.map((f) => [f.family, f.descriptors['font-style']]));
    expect(restored.slice(0, 3).map((f) => f.src[0]!.url)).toEqual([0, 1, 2].map((i) => expect.stringMatching(new RegExp(`^/__fontphobia/before/[0-9a-f]{16}/${i === 2 ? 'DejaVuSans' : 'InterVariable'}\\.ttf$`))));
    expect(restored[3]!.src[0]!.url).toBe('./fonts/Inter-Regular-hinted.woff2'); // never generated
    const html = o.restoreHtml(readFileSync(join(root, 'index.html'), 'utf8'))!;
    expect(html).toMatch(/<link rel="preload" href="\/__fontphobia\/before\/[0-9a-f]{16}\/InterVariable\.ttf" as="font" type="font\/ttf" crossorigin>/);
    expect(o.restoreCss('body { color: red }')).toBeUndefined();
  }, 120_000);
});

describe.skipIf(!chrome)('verify in Chrome (§10.3)', () => {
  it('a clean build renders pixel for pixel like the original fonts, at every viewport and DPR', async () => {
    const root = await built('clean');
    const r = await verify({ root, usage, viewports: [360, 1280], dprs: [1, 2], outDir: outDir('clean') });
    expect(r.static.findings).toEqual([]);
    expect(r.browser!.rejected).toEqual([]);
    expect(r.browser!.loads).toEqual([]);
    expect(differences(r)).toEqual([]);
    expect(r.browser!.comparisons.map((c) => `${c.page} ${c.viewport} ${c.dpr}`)).toEqual(
      ['/', '/about/', '/edge.html'].flatMap((p) => ['360 1', '360 2', '1280 1', '1280 2'].map((v) => `${p} ${v}`)));
    // On macOS every comparison is pixel-identical, at once or on a reload (every differing pixel counts, so a
    // busy machine can show one-off rasterizer noise as `flaky`); elsewhere system-font text may show unrelated noise.
    if (process.platform === 'darwin') expect(r.browser!.comparisons.filter((c) => c.class !== 'flaky' && !(c.class === 'identical' && c.pixels === 0)).map((c) => `${c.page} ${c.viewport} ${c.dpr} ${c.class} ${c.pixels}px`)).toEqual([]);
    // Every page downloads less, and the about page only Inter's core.
    for (const p of r.browser!.bytes) expect(p.after.bytes).toBeLessThan(p.before.bytes);
    expect(r.browser!.bytes.find((p) => p.page === '/about/')!.faces).toEqual({ 'inter-100-900-normal': { before: 879708, after: expect.any(Number) } });
    expect(r.ok).toBe(true);
    const text = formatVerify(r, root);
    expect(text).toContain('Verify passed');
    const md = verifyMarkdown('# report\n\nAudit things.\n', r, root);
    expect(verifyMarkdown(md, r, root)).toBe(md); // replaces its own section
  }, 300_000);

  it('--mask hides content that differs by itself between loads; --ignore skips pages', async () => {
    const root = await built('mask');
    // A canvas painted from crypto randomness (verify seeds Math.random, not this) and hidden text that moves.
    const page = readFileSync(join(root, 'about/index.html'), 'utf8').replace('</body>', `<canvas id="noise" width="200" height="60"></canvas><p class="ghost" style="visibility:hidden">hidden</p>
<script>const c=document.getElementById('noise').getContext('2d');const v=crypto.getRandomValues(new Uint8Array(3));c.fillStyle='rgb('+v.join(',')+')';c.fillRect(0,0,200,60);
document.querySelector('.ghost').style.marginLeft=v[0]+'px';</script></body>`);
    writeFileSync(join(root, 'about/index.html'), page);
    const o = { root, usage, viewports: [1280], dprs: [1], pages: ['/about/'], maxPages: 1 };
    const noisy = await verify(o);
    expect(noisy.browser!.comparisons.find((c) => c.page === '/about/')!.class).not.toBe('identical');
    const masked = await verify({ ...o, mask: ['#noise'] });
    expect(masked.browser!.comparisons.find((c) => c.page === '/about/')!.class).toBe('identical');
    const skipped = await verify({ ...o, ignore: ['/about/'] });
    expect(skipped.browser!.comparisons.map((c) => c.page)).not.toContain('/about/');
  }, 300_000);

  it('notices a site that was not rebuilt after build --write', async () => {
    const root = await built('stale');
    const old = copy('stale-dist'); // the original site, as an old build would serve it
    const r = await verify({ root, usage, dist: old, viewports: [1280], dprs: [1] });
    expect(r.ok).toBe(false);
    expect(r.browser!.loads[0]!.problem).toMatch(/loads none of fontphobia's files/);
  }, 300_000);

  const face = 'inter-100-900-normal';
  const cases: [string, Mutation, RegExp][] = [
    // ș: no decomposition fallback (é would render identically as e + U+0301 from core; the static layer still flags it).
    ['drop a used character', { face, kind: 'drop-char', cp: 0x219 }, /^fallback font: system /],
    ['drop a used feature', { face, kind: 'drop-feature', tag: 'tnum' }, /^width changed/],
    ['pin an axis that something overrides', { face, kind: 'pin-axis', tag: 'wght', value: 400 }, /^width changed/],
    ['give the extended file its own family name', { face, kind: 'ext-family', family: 'Inter Ext' }, /^fallback font: system /],
  ];
  for (const [name, mutation, cause] of cases) {
    it(`mutation: ${name}`, async () => {
      const root = await built(mutation.kind, mutation);
      const r = await verify({ root, usage, viewports: [1280], dprs: [1] });
      expect(r.ok).toBe(false);
      const bad = r.browser!.comparisons.filter((c) => c.class === 'regression');
      expect(bad.length).toBeGreaterThan(0);
      expect(bad.flatMap((c) => c.causes)).toContainEqual(expect.stringMatching(cause));
      // Each example says where the text is.
      expect(bad.flatMap((c) => c.examples).filter((e) => e.text).every((e) => typeof e.where === 'string' && e.where.length > 0)).toBe(true);
      expect(r.static.ok).toBe(false);
    }, 300_000);
  }

  it('mutation: move a combining mark out of core (caught by shaping; Inter draws the composed letter identically)', async () => {
    const root = await built('mark-out-of-core', { face, kind: 'mark-out-of-core' });
    const r = await verify({ root, usage, viewports: [1280], dprs: [1] });
    expect(r.ok).toBe(false);
    expect(r.static.findings.map((f) => `${f.kind} ${f.message}`)).toContainEqual(expect.stringMatching(/^shaping \d+ of \d+ shaping case\(s\) differ/));
  }, 300_000);
});

// Playwright's builds, when installed and allowed to start (Firefox can't inside a sandbox that guards
// ~/Library/Application Support/Firefox; it runs in the Linux image below either way).
for (const engine of ['webkit', 'firefox'] as const) {
  describe.skipIf(!chrome || !hostEngines[engine])(`verify in ${engine} on this machine (§10.3)`, () => {
    it('a clean build is pixel-identical', async () => {
      const root = await built(`host-${engine}`);
      // WebKit on macOS draws the fixture's synthesized small caps one pixel differently at DPR 1
      // (docs/notes/webkit-small-caps.md): that paragraph is masked there, everything else is compared.
      const mask = engine === 'webkit' && process.platform === 'darwin' ? ['#caps'] : undefined;
      const r = await verify({ root, usage, viewports: [360, 1280], dprs: [1, 2], browsers: [engine], mask, outDir: outDir(engine) });
      expect(differences(r)).toEqual([]);
      expect(r.browser!.rejected).toEqual([]);
      expect(r.ok).toBe(true);
    }, 300_000);
  });
}

describe.skipIf(!runtime)('verify in the pinned Linux image (§10.3, --hinting)', () => {
  it('is pixel-identical in Linux Chromium with hinting on, Firefox and WebKit (auto-hinter references and glyph aliases)', async () => {
    const root = await built('linux');
    const r = await verify({ root, usage, viewports: [1280], dprs: [1, 2], browsers: ['linux-firefox', 'linux-webkit'], hinting: true, outDir: outDir('linux') });
    expect(r.browser!.browsers.map((b) => b.engine)).toEqual(['linux-firefox', 'linux-webkit', 'linux-chromium']);
    // --hinting alone is DPR 1.
    expect(r.browser!.comparisons.filter((c) => c.browser === 'linux-chromium').map((c) => c.dpr)).toEqual([1, 1, 1]);
    expect(differences(r)).toEqual([]);
    expect(r.ok).toBe(true);
  }, 600_000);
});

describe.skipIf(!chrome)('verify --baseline worktree (§10.3)', () => {
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
  function repo(name: string) {
    const root = copy(name);
    g(root, 'init', '-q', '-b', 'main');
    g(root, 'add', '-A');
    g(root, 'commit', '-q', '-m', 'site');
    return root;
  }

  it('builds HEAD in a worktree as "before", whether the build is committed or not, and cleans up', async () => {
    const root = repo('worktree');
    await buildProject(root, usage, {}, { version: '1', write: true });
    const r1 = await verify({ root, usage, viewports: [1280], dprs: [1], baseline: 'worktree', outDir: outDir('worktree') });
    expect(r1.browser!.baseline).toBe('worktree');
    expect(differences(r1)).toEqual([]);
    expect(r1.browser!.comparisons.map((c) => c.class)).toEqual(['identical', 'identical', 'identical']);
    expect(r1.browser!.bytes.find((p) => p.page === '/about/')!.faces['inter-100-900-normal']!.before).toBe(879708);
    expect(r1.ok).toBe(true);
    // Committed: the worktree reverts fontphobia's blocks to get "before".
    g(root, 'add', '-A');
    g(root, 'commit', '-q', '-m', 'fontphobia');
    const r2 = await verify({ root, usage, viewports: [1280], dprs: [1], baseline: 'worktree' });
    expect(r2.ok).toBe(true);
    expect(g(root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  }, 300_000);

  it('refuses when the working tree has changes besides fontphobia\'s', async () => {
    const root = repo('worktree-dirty');
    await buildProject(root, usage, {}, { version: '1', write: true });
    writeFileSync(join(root, 'about/index.html'), readFileSync(join(root, 'about/index.html'), 'utf8').replace('About', 'About us'));
    await expect(verify({ root, usage, viewports: [1280], dprs: [1], baseline: 'worktree' })).rejects.toThrow(/changes besides fontphobia's: about\/index\.html/);
  }, 300_000);
});
