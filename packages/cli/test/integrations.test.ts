// §13: every framework integration runs `check` after the framework wrote its HTML, in a real build
// (and, with `auto`, subsets that output instead: Astro, Nuxt and Next below).
// A build with nothing built passes and logs the check; a stale manifest fails it. The bundler
// plugins also keep fontphobia's files out of asset inlining. Opt-in: FONTPHOBIA_SITES=1, after
// `pnpm install` in fixtures/integrations, fixtures/sites/nuxt and fixtures/sites/next.
import { execFileSync, spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = join(repo, 'fixtures/integrations');
const enabled = !!process.env.FONTPHOBIA_SITES && existsSync(join(fixtures, 'node_modules'));
const dist = join(repo, 'packages/cli/dist');

const STALE = JSON.stringify({
  version: 1,
  fontphobia: '0.0.0',
  harfbuzz: 'x',
  chrome: 'x',
  entries: {
    gone: {
      id: 'gone',
      adapter: 'css',
      family: 'Gone',
      stylesheet: 'gone.css',
      declaration: '@font-face{font-family:Gone;src:url(gone.ttf)}',
      source: { file: 'fonts/gone.ttf', sha256: '0'.repeat(64), bytes: 1 },
      outputs: [],
      plan: { features: [], axes: {}, descriptors: {}, hinting: true, optIns: [] },
    },
  },
});

function build(dir: string, cmd: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: dir,
    env: { ...process.env, NODE_ENV: 'production', CI: '1', ...env },
    encoding: 'utf8',
    timeout: 600_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

/** Both runs: nothing built (passes, and says there is nothing to check), then a stale manifest (fails, says why). */
function roundTrip(dir: string, cmd: string[], env?: Record<string, string>) {
  const ok = build(dir, cmd, env);
  expect(ok.out).toContain('fontphobia: nothing to check');
  expect(ok.code).toBe(0);
  writeFileSync(join(dir, 'fontphobia.manifest.json'), STALE);
  try {
    const bad = build(dir, cmd, env);
    expect(bad.out).toContain('the source font fonts/gone.ttf is gone');
    expect(bad.code).not.toBe(0);
  } finally {
    rmSync(join(dir, 'fontphobia.manifest.json'), { force: true });
  }
}

/** Built CSS: the 900-byte non-fontphobia font inlines (0x01 bytes), fontphobia's stays a file (0x02 bytes). */
function expectGuard(outDir: string) {
  const css: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) css.push(readFileSync(p, 'utf8'));
    }
  };
  walk(outDir);
  const all = css.join('\n');
  expect(all).toContain('base64,AQEBAQEB');
  expect(all).not.toContain('base64,AgICAgIC');
}

const bin = (name: string) => join(fixtures, 'node_modules/.bin', name);

/** With `auto`: the build subsets its own output, and the subset files pass their checks. */
function expectAuto(out: string, outDir: string) {
  expect(out).toMatch(/fontphobia auto \(static\): \d+ face\(s\) subset in /);
  expect(out).toMatch(/Checked without a browser: \d+ file\(s\) decode and match their sources/);
  const names: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else names.push(e.name);
    }
  };
  walk(outDir);
  expect(names.some((n) => /\.core\.[0-9a-f]{8}\.woff2$/.test(n))).toBe(true);
}

describe.skipIf(!enabled)('framework integrations (§13)', () => {
  beforeAll(() => {
    execFileSync('pnpm', ['run', 'build'], { cwd: join(repo, 'packages/cli'), stdio: 'ignore' });
  }, 120_000);

  it(
    'react-router: buildEnd',
    () => roundTrip(join(fixtures, 'react-router'), [bin('react-router'), 'build']),
    600_000,
  );
  it('vitepress: buildEnd', () => roundTrip(join(fixtures, 'vitepress'), [bin('vitepress'), 'build', 'docs']), 600_000);
  it('eleventy: eleventy.after', () => roundTrip(join(fixtures, 'eleventy'), [bin('eleventy')]), 600_000);
  it('docusaurus: postBuild, and the asset guard', () => {
    roundTrip(join(fixtures, 'docusaurus'), [bin('docusaurus'), 'build']);
    expectGuard(join(fixtures, 'docusaurus/build'));
  }, 600_000);
  it('rsbuild: onAfterBuild, and the asset guard', () => {
    roundTrip(join(fixtures, 'rsbuild'), [bin('rsbuild'), 'build']);
    expectGuard(join(fixtures, 'rsbuild/dist'));
  }, 600_000);
  it('rspack: compiler done, and the asset guard', () => {
    roundTrip(join(fixtures, 'rspack'), [bin('rspack'), 'build']);
    expectGuard(join(fixtures, 'rspack/dist'));
  }, 600_000);

  // The Nuxt and Next fixtures, copied, with the integration added.
  const copy = (site: string, edit: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), `fontphobia-int-${site}-`));
    cpSync(join(repo, 'fixtures/sites', site), root, {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|\.next|out|\.nuxt|\.output|dist|\.fontphobia)$/.test(p),
    });
    cpSync(join(repo, 'fixtures/sites', site, 'node_modules'), join(root, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    edit(root);
    return root;
  };
  it.skipIf(!existsSync(join(repo, 'fixtures/sites/astro/node_modules')))(
    'astro: `auto` subsets the build in astro:build:done (Fontsource slices and a local font)',
    () => {
      const root = copy('astro', (r) =>
        writeFileSync(
          join(r, 'astro.config.mjs'),
          `import { defineConfig } from 'astro/config';\nimport fontphobia from ${JSON.stringify(join(dist, 'astro.mjs'))};\nexport default defineConfig({ integrations: [fontphobia({ auto: true })] });\n`,
        ),
      );
      try {
        const r = build(root, [join(root, 'node_modules/.bin/astro'), 'build']);
        expect(r.code).toBe(0);
        expectAuto(r.out, join(root, 'dist'));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    900_000,
  );
  it.skipIf(!existsSync(join(repo, 'fixtures/sites/nuxt/node_modules')))(
    'nuxt: a module on nitro:build:public-assets',
    () => {
      const root = copy('nuxt', (r) =>
        writeFileSync(
          join(r, 'nuxt.config.ts'),
          readFileSync(join(r, 'nuxt.config.ts'), 'utf8').replace(
            "modules: ['@nuxt/fonts']",
            `modules: ['@nuxt/fonts', ${JSON.stringify(join(dist, 'nuxt.mjs'))}]`,
          ),
        ),
      );
      try {
        roundTrip(root, [join(root, 'node_modules/.bin/nuxt'), 'generate']);
        // The module's `auto` option: Google's slices of Merriweather, subset in .output/public.
        writeFileSync(
          join(root, 'nuxt.config.ts'),
          readFileSync(join(root, 'nuxt.config.ts'), 'utf8').replace(
            JSON.stringify(join(dist, 'nuxt.mjs')),
            `[${JSON.stringify(join(dist, 'nuxt.mjs'))}, { auto: true }]`,
          ),
        );
        const r = build(root, [join(root, 'node_modules/.bin/nuxt'), 'generate']);
        expect(r.code).toBe(0);
        expectAuto(r.out, join(root, '.output/public'));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    900_000,
  );
  it.skipIf(!existsSync(join(repo, 'fixtures/sites/next/node_modules')))(
    'next: an adapter with onBuildComplete',
    () => {
      const root = copy('next', (r) =>
        writeFileSync(
          join(r, 'next.config.mjs'),
          readFileSync(join(r, 'next.config.mjs'), 'utf8').replace(
            'export default {',
            `export default { adapterPath: ${JSON.stringify(join(dist, 'next.mjs'))},`,
          ),
        ),
      );
      try {
        roundTrip(root, [join(root, 'node_modules/.bin/next'), 'build']);
        // The adapter takes no options: `auto` comes from the config.
        writeFileSync(join(root, 'fontphobia.config.json'), '{"auto":true}');
        const r = build(root, [join(root, 'node_modules/.bin/next'), 'build']);
        expect(r.code).toBe(0);
        expectAuto(r.out, join(root, 'out'));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
