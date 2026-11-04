// next-font-google (§6.4): narrowing next/font/google options, with check and revert. No Next needed
// for weights; `axes` needs Next's font data, so that case is in the sites tests.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProject, checkProject, findGoogleFontCalls, literalProp, readManifest, revertProject, type UsageFaceJson, type UsageFileJson } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-nextg-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('next/font/google calls', () => {
  it('finds calls, aliases and literal options', () => {
    const root = mkdtempSync(join(tmp, 'find-'));
    writeFileSync(join(root, 'fonts.js'), `import { Lato, Roboto_Mono as Mono } from 'next/font/google';\nexport const a = Lato({ subsets: ['latin'], weight: ["300", "400"] });\nexport const b = Mono({ subsets: ['latin'] });\n`);
    const calls = findGoogleFontCalls(root);
    expect(calls.map((c) => [c.family, c.line, c.arg])).toEqual([['Lato', 2, `{ subsets: ['latin'], weight: ["300", "400"] }`], ['Roboto Mono', 3, `{ subsets: ['latin'] }`]]);
    expect(literalProp(calls[0]!.arg, 'weight')).toMatchObject({ values: ['300', '400'], quote: '"', array: true, numeric: false });
    expect(literalProp(`{ weights: [400, 700] }`, 'weights')).toMatchObject({ values: ['400', '700'], array: true, numeric: true });
    expect(literalProp(`{ weights: [400, '700'] }`, 'weights')).toBeUndefined();
    expect(literalProp(`{ weight: '400' }`, 'weight')).toMatchObject({ values: ['400'], array: false });
    expect(literalProp(`{ weight: w }`, 'weight')).toBeUndefined();
    expect(literalProp(`{ weight: ['400', w] }`, 'weight')).toBeUndefined();
  });
});

const face = (w: number): UsageFaceJson => ({
  family: 'Lato', descriptors: { 'font-family': 'Lato', 'font-weight': String(w), 'font-style': 'normal', src: `url(/_next/static/media/lato-${w}.woff2) format('woff2')` },
  source: { adapter: 'next-font-google' }, files: [{ url: `/_next/static/media/lato-${w}.woff2`, sha256: '0'.repeat(64), bytes: 1000 }],
  chars: 'Hi', count: 2, inserted: {}, contexts: [], rendered: { weight: [w], style: ['normal'], axes: {} }, declared: {}, features: [], locales: ['en'], pages: ['/'],
});
const usage = (ws: number[]): UsageFileJson => ({
  version: 1, meta: { fontphobia: '1', harfbuzz: '1', chrome: '150', framework: 'next', mode: 'static', viewports: [1280], fontSizes: [16] },
  faces: Object.fromEntries(ws.map((w) => [`lato-${w}-normal`, face(w)])), pages: { '/': { faces: {}, bytes: 0, fonts: [] } },
});

describe('build, check and revert', () => {
  it('drops weights nothing matches, keeps the original for revert, and check reports one asked for again', async () => {
    const root = mkdtempSync(join(tmp, 'site-'));
    const src = `import { Lato } from 'next/font/google';\n\nexport const lato = Lato({\n  subsets: ['latin'],\n  weight: ['100', '300', '400', '700', '900'],\n});\n`;
    writeFileSync(join(root, 'fonts.js'), src);
    writeFileSync(join(root, 'globals.css'), 'h1 { font-weight: 900; }\n');
    writeFileSync(join(root, 'package.json'), '{"name":"t","private":true}\n');
    const def = await buildProject(root, usage([400, 700, 900]), {}, { version: '1', write: true });
    expect(def.edits).toEqual([]);
    expect(def.suggestions).toEqual([{ kind: 'options', adapter: 'next-font-google', file: 'fonts.js', family: 'Lato', weights: [100, 300] }]);
    const r = await buildProject(root, usage([400, 700, 900]), { allow: ['tighten'] }, { version: '1', write: true });
    // 400, 700, 900 asked for (bolder of 700 is 900); 100 and 300 match nothing.
    expect(readFileSync(join(root, 'fonts.js'), 'utf8')).toBe(src.replace(`['100', '300', '400', '700', '900']`, `['400', '700', '900']`));
    expect(r.manifest.options).toEqual([{ adapter: 'next-font-google', file: 'fonts.js', family: 'Lato', from: `{\n  subsets: ['latin'],\n  weight: ['100', '300', '400', '700', '900'],\n}`, to: `{\n  subsets: ['latin'],\n  weight: ['400', '700', '900'],\n}`, dropped: { weights: [100, 300], axes: [] } }]);
    expect((await buildProject(root, usage([400, 700, 900]), {}, { version: '1' })).unchanged).toBe(true);
    expect((await checkProject({ root })).issues).toEqual([]);
    appendFileSync(join(root, 'globals.css'), '.light { font-weight: 300; }\n');
    expect((await checkProject({ root })).issues.map((i) => i.message)).toEqual(['Lato 300 is asked for again, but build dropped it from the Lato next/font/google call in fonts.js']);
    const rv = revertProject(root, { write: true });
    expect(rv.problems).toEqual([]);
    expect(readFileSync(join(root, 'fonts.js'), 'utf8')).toBe(src);
    expect(readManifest(root)).toBeUndefined();
  });
});

describe('Astro fonts[] (§6.8)', () => {
  it('finds entries in astro.config and narrows a numeric weights list', async () => {
    const root = mkdtempSync(join(tmp, 'astro-'));
    const cfg = `import { defineConfig, fontProviders } from 'astro/config';\nexport default defineConfig({\n  fonts: [\n    { provider: fontProviders.google(), name: 'Lato', cssVariable: '--font-lato', weights: [100, 300, 400, 700, 900], styles: ['normal'] },\n    { provider: fontProviders.google(), name: 'Lora', cssVariable: '--font-lora' },\n  ],\n});\n`;
    writeFileSync(join(root, 'astro.config.mjs'), cfg);
    writeFileSync(join(root, 'package.json'), '{"name":"t","private":true}\n');
    const { findAstroFontsEntries, astroFamily } = await import('../src/index.ts');
    expect(findAstroFontsEntries(root).map((e) => [e.family, e.line])).toEqual([['Lato', 4], ['Lora', 5]]);
    expect(astroFamily('Lato-4695a571cd365f71')).toBe('Lato');
    const u = usage([400, 700]);
    for (const f of Object.values(u.faces)) { f.family = 'Lato-4695a571cd365f71'; f.source = { adapter: 'astro-fonts' }; }
    const r = await buildProject(root, u, { allow: ['tighten'] }, { version: '1', write: true });
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toBe(cfg.replace('weights: [100, 300, 400, 700, 900]', 'weights: [400, 700, 900]'));
    expect(r.manifest.options?.map((x) => [x.adapter, x.family, x.dropped.weights])).toEqual([['astro-fonts', 'Lato', [100, 300]]]);
    expect(revertProject(root, { write: true }).problems).toEqual([]);
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toBe(cfg);
  });

  it('by default, preloads only the faces pages load and leaves every face declared', async () => {
    const root = mkdtempSync(join(tmp, 'astro-preload-'));
    const cfg = `export default {\n  fonts: [{ name: 'Lato', cssVariable: '--font-lato', weights: [400, 700], styles: ['normal', 'italic'] }],\n};\n`;
    const layout = `---\nimport { Font } from 'astro:assets';\n---\n<head><Font cssVariable="--font-lato" preload /></head>\n`;
    writeFileSync(join(root, 'astro.config.mjs'), cfg);
    writeFileSync(join(root, 'Layout.astro'), layout);
    writeFileSync(join(root, 'package.json'), '{"name":"t","private":true}\n');
    const u = usage([400, 700]);
    for (const f of Object.values(u.faces)) { f.family = 'Lato-4695a571cd365f71'; f.source = { adapter: 'astro-fonts' }; }
    const r = await buildProject(root, u, {}, { version: '1', write: true });
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toBe(cfg);
    expect(readFileSync(join(root, 'Layout.astro'), 'utf8')).toBe(layout.replace(' preload />', ` preload={[{ weight: '400', style: 'normal' }, { weight: '700', style: 'normal' }]} />`));
    expect(r.manifest.options?.map((x) => [x.kind, x.family])).toEqual([['preload', 'Lato']]);
    expect((await buildProject(root, u, {}, { version: '1' })).unchanged).toBe(true);
    expect((await checkProject({ root })).issues).toEqual([]);
    expect(revertProject(root, { write: true }).problems).toEqual([]);
    expect(readFileSync(join(root, 'Layout.astro'), 'utf8')).toBe(layout);
  });
});
