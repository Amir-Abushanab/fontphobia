// M2 acceptance on the static `css` fixture: every §7.4 rule, per-face attribution, declared
// values, preloads, and a byte-identical usage.json from two crawls. Needs Google Chrome.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProject, canonicalJson, checkUsage, codePointsOf, parseUnicodeRange, type UsageFileJson } from '@fontphobia/core';
import { audit, launchChrome, resolveStatic, startServer, type AuditResult } from '../src/index.ts';
import { writeGoldenUsage } from './golden.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-crawl-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let chrome = true;
try { await (await launchChrome()).close(); } catch (e) {
  if (process.env.CI) throw e;
  chrome = false;
}

const site = join(tmp, 'static-css');
cpSync(join(repo, 'fixtures/sites/static-css'), site, { recursive: true });
mkdirSync(join(site, 'fonts'));
for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) cpSync(join(repo, 'fixtures/fonts', f), join(site, 'fonts', f));

type Face = { chars: string; inserted: Record<string, string>; rendered: { weight?: number[]; axes?: Record<string, number[]> }; declared: { weight?: number[] }; features: string[]; editable?: boolean; source: { adapter: string; line?: number }; pages: string[] };
const set = (ranges: string | undefined) => new Set(ranges ? [...codePointsOf(parseUnicodeRange(ranges))] : []);
const has = (ranges: string | undefined, chars: string) => { const s = set(ranges); return [...chars].filter((c) => !s.has(c.codePointAt(0)!)); };

describe.skipIf(!chrome)('audit: static css fixture', () => {
  let r: AuditResult;
  let faces: Record<string, Face>;
  beforeAll(async () => {
    r = await audit({ root: site, dist: '.', fontphobiaVersion: 'test' });
    faces = r.usage.faces as unknown as Record<string, Face>;
    // The planner's golden input (packages/core/test/plan.test.ts): `pnpm plans:update`.
    if (process.env.UPDATE_GOLDEN) writeGoldenUsage('static-css', r.usage);
  }, 240_000);

  it('finds the pages and records the failure', () => {
    expect(r.crawl.pages).toEqual(['/', '/about/', '/edge.html']);
    expect(r.crawl.failed).toEqual({ '/missing.html': 'HTTP 404' });
    expect(r.crawl.fontSizes).toEqual([9, 12, 16, 20, 24, 72]); // the fixture has an em media query
  });

  it('attributes per face and matches each face to its declaration', () => {
    expect(Object.keys(faces).toSorted()).toEqual(['deja-400-normal', 'inter-100-900-italic', 'inter-100-900-normal']);
    expect(faces['inter-100-900-normal']!.source).toMatchObject({ adapter: 'css', line: 2 });
    expect(faces['inter-100-900-italic']!.source).toMatchObject({ adapter: 'css', line: 9 });
    expect(Object.keys(r.usage.unloaded)).toEqual(['unused-400-normal']);
    // Bold inside italics goes to the italic face, with weight 700.
    expect(has(faces['inter-100-900-italic']!.chars, 'italic bold')).toEqual([]);
    expect(faces['inter-100-900-italic']!.rendered.weight).toEqual([400, 700]);
    expect(faces['inter-100-900-normal']!.pages).toEqual(['/', '/about/', '/edge.html']);
  });

  it('keeps accented, Romanian, Vietnamese and decomposed text; CJK and emoji stay on system fonts', () => {
    const n = faces['inter-100-900-normal']!.chars;
    expect(has(n, 'Țășéếệở\u0301\u0308')).toEqual([]);
    const fb = (r.usage.pages['/edge.html'] as { fallback: Record<string, string> }).fallback['sans-serif'];
    expect(has(fb, '☃日本語😀')).toEqual([]);
  });

  it('applies every §7.4 rule to the faces its trigger applies to', () => {
    const n = faces['inter-100-900-normal']!;
    expect(has(n.inserted.hyphens, '‐-')).toEqual([]);
    expect(has(n.inserted['text-overflow'], '….')).toEqual([]);
    expect(has(n.inserted.password, '•●■')).toEqual([]);
    expect(has(n.inserted['list markers'], 'IVXLCDM0123456789. ✓')).toEqual([]);
    expect(n.inserted['input type=date']).toBeTruthy();
    expect(has(n.chars, '„“')).toEqual([]); // <q> in en and de, from the layout text
    expect(has(n.chars, 'äØΩñÿ')).toEqual([]); // placeholder, <option>, <textarea>, contenteditable
    expect(n.editable).toBe(true);
    expect(set(n.chars).has(0xbf)).toBe(false); // #plain keeps the system font
    const d = faces['deja-400-normal']!;
    expect(has(d.inserted['synthesized small caps'], 'SMALCP')).toEqual([]);
    expect(has(d.chars, 'First line')).toEqual([]); // ::first-line in Deja
    expect(has(d.chars, '->!=')).toEqual([]); // code
  });

  it('collects declared values, features and axes (§7.5)', () => {
    const n = faces['inter-100-900-normal']!;
    expect(n.declared.weight).toEqual(expect.arrayContaining([300, 400, 500, 600, 650, 800, 900]));
    expect(Object.keys(n.inserted).filter((k) => k.startsWith('declared')).toSorted()).toEqual(['declared :hover', 'declared @keyframes pulse', 'declared @media (min-width: 40em)', 'declared @media print']);
    expect(n.features).toEqual(expect.arrayContaining(['ss01', 'tnum']));
    const opsz = n.rendered.axes!.opsz!;
    expect(Math.min(...opsz)).toBe(14);
    expect(Math.max(...opsz)).toBe(32);
    expect(opsz).toContain(28); // inline font-variation-settings
  });

  it('reports bytes and preloads per page', () => {
    const home = r.usage.pages['/'] as { bytes: number; preloads: { href: string; used: boolean; crossorigin: string | null }[] };
    expect(home.bytes).toBeGreaterThan(800_000);
    expect(home.preloads).toEqual([
      { href: '/fonts/Inter-Regular-hinted.woff2', crossorigin: null, type: 'font/woff2', used: false },
      { href: '/fonts/InterVariable.ttf', crossorigin: '', type: 'font/ttf', used: true },
    ]);
  });

  it('writes the same usage.json from a second crawl', async () => {
    const again = await audit({ root: site, dist: '.', fontphobiaVersion: 'test', concurrency: 2, cache: false });
    expect(canonicalJson(again.usage)).toBe(canonicalJson(r.usage));
  }, 240_000);
});

describe('static server', () => {
  it('resolves directory indexes and clean URLs, and stays inside the root', () => {
    expect(resolveStatic(site, '/')).toBe(join(site, 'index.html'));
    expect(resolveStatic(site, '/about')).toBe(join(site, 'about/index.html'));
    expect(resolveStatic(site, '/edge')).toBe(join(site, 'edge.html'));
    expect(resolveStatic(site, '/../package.json')).toBeUndefined();
    expect(resolveStatic(site, '/nope/')).toBeUndefined();
  });
});

describe('server mode', () => {
  it('starts a server on $PORT, or finds the URL it prints, and stops it', async () => {
    const script = join(tmp, 'srv.mjs');
    writeFileSync(script, `import http from 'node:http';
const port = process.argv[2] === 'own' ? 0 : Number(process.env.PORT);
const s = http.createServer((q, r) => r.end('ok')).listen(port, '127.0.0.1', () => console.log('Listening on http://localhost:' + s.address().port + '/'));`);
    for (const mode of ['port', 'own']) {
      const s = await startServer(`node "${script}" ${mode}`, { cwd: tmp });
      expect(await (await fetch(s.url)).text()).toBe('ok');
      await s.stop();
      await expect(fetch(s.url)).rejects.toThrow();
    }
  });
  it('reports a server that exits', async () => {
    await expect(startServer('node -e "console.log(\'boom\'); process.exit(3)"', { cwd: tmp })).rejects.toThrow(/exited with code 3[\s\S]*boom/);
  });
});


describe.skipIf(!chrome)('stale builds', () => {
  it('asks before crawling output older than the source, and rebuilds on yes', async () => {
    const root = join(tmp, 'stale');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), '{"devDependencies":{"vite":"8"},"scripts":{"build":"node build.mjs"}}');
    writeFileSync(join(root, 'build.mjs'), `import fs from 'node:fs'; fs.writeFileSync('dist/index.html', '<p>' + fs.readFileSync('src/text.txt', 'utf8'));`);
    writeFileSync(join(root, 'src/text.txt'), 'old');
    writeFileSync(join(root, 'dist/index.html'), '<p>old');
    const t = Date.now() / 1000;
    for (const f of ['package.json', 'build.mjs', 'dist/index.html']) utimesSync(join(root, f), t - 3600, t - 3600);
    writeFileSync(join(root, 'src/text.txt'), 'new');
    const opts = { root, fontphobiaVersion: 'test', fontSizeSweep: false, viewports: [1280] };

    let asked = 0;
    const kept = await audit({ ...opts, onStale: () => { asked++; return false; } });
    expect(asked).toBe(1);
    expect(kept.crawl.built).toBeUndefined();
    expect(kept.crawl.build).toMatchObject({ output: 'dist', newer: { file: 'src/text.txt', count: 1 } });

    const rebuilt = await audit({ ...opts, onStale: (age) => age.newer!.file === 'src/text.txt' });
    expect(rebuilt.crawl.built).toBe('npm run build');
    expect(rebuilt.crawl.build).toBeUndefined();
    // Fresh output now: no question.
    const again = await audit({ ...opts, onStale: () => { throw new Error('asked about a fresh build'); } });
    expect(again.crawl.build?.newer).toBeUndefined();
  }, 120_000);
});

describe.skipIf(!chrome)('incremental audit (M3.5)', () => {
  it('reuses every visit of an unchanged site, and re-visits only an edited page, matching a full crawl byte for byte', async () => {
    const root = join(tmp, 'incremental');
    cpSync(site, root, { recursive: true });
    rmSync(join(root, '.fontphobia'), { recursive: true, force: true });
    const opts = { root, dist: '.', fontphobiaVersion: 'test', viewports: [360, 1280] };
    const a1 = await audit(opts);
    // `stored` first: a visit the first run couldn't store is one the second has to make again.
    expect(a1.crawl.cache).toEqual({ reused: 0, visited: a1.crawl.visits, stored: a1.crawl.visits });
    const a2 = await audit(opts);
    expect(a2.crawl.cache).toEqual({ reused: a1.crawl.visits, visited: 0, stored: 0 });
    expect(canonicalJson(a2.usage)).toBe(canonicalJson(a1.usage));

    // One page's content changes: only its visits run again.
    const about = join(root, 'about/index.html');
    writeFileSync(about, readFileSync(about, 'utf8').replace('Only ASCII here', 'Only ASCII here, and ñ'));
    const a3 = await audit(opts);
    const aboutVisits = a1.usage.pages['/about/']!.visits.length;
    expect(a3.crawl.cache).toEqual({ reused: a1.crawl.visits - aboutVisits, visited: aboutVisits, stored: aboutVisits });
    const full = await audit({ ...opts, cache: false });
    expect(full.crawl.cache).toBeUndefined();
    expect(canonicalJson(a3.usage)).toBe(canonicalJson(full.usage));
    expect(canonicalJson(a3.usage)).not.toBe(canonicalJson(a1.usage));
    // A shared stylesheet change re-visits everything.
    writeFileSync(join(root, 'styles.css'), readFileSync(join(root, 'styles.css'), 'utf8') + '\n/* edit */\n');
    expect((await audit(opts)).crawl.cache!.reused).toBe(0);
  }, 300_000);
});

describe.skipIf(!chrome)('after build --write (M4)', () => {
  it('renders from the subset files, and audit → build → audit → build changes nothing', async () => {
    const root = join(tmp, 'written');
    cpSync(site, root, { recursive: true });
    rmSync(join(root, '.fontphobia'), { recursive: true, force: true });
    const opts = { root, dist: '.', fontphobiaVersion: 'test', fontSizeSweep: false, viewports: [1280] };
    const first = await audit(opts);
    const u1 = first.usage as unknown as UsageFileJson;
    const b1 = await buildProject(root, u1, {}, { version: 'test', write: true });
    expect(b1.notWritten).toEqual([]);
    const second = await audit(opts);
    const u2 = second.usage as unknown as UsageFileJson;
    // Each page now loads only subset files (no 404s), and the folded faces are the same faces.
    for (const [p, pg] of Object.entries(u2.pages)) {
      for (const f of pg.fonts) {
        expect(f.status, `${p} ${f.url}`).toBeLessThan(400);
        if (f.faces.some((id) => id.startsWith('inter') || id.startsWith('deja'))) expect(f.url).toMatch(/\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/);
      }
      expect(pg.bytes).toBeLessThan(u1.pages[p]!.bytes);
    }
    expect(Object.keys(u2.faces)).toEqual(Object.keys(u1.faces));
    for (const [id, f] of Object.entries(u1.faces)) {
      const g = u2.faces[id]!;
      expect(g.chars, id).toBe(f.chars);
      expect(g.contexts, id).toEqual(f.contexts);
      expect(g.source).toMatchObject({ adapter: 'css', fontFile: f.source.fontFile });
    }
    const b2 = await buildProject(root, u2, {}, { version: 'test', write: true });
    expect(b2.unchanged).toBe(true);

    // M6, check's exact mode: a crawl of the built site against the written files.
    expect((await checkUsage(root, u2)).issues).toEqual([]);
    const about = join(root, 'about/index.html');
    writeFileSync(about, readFileSync(about, 'utf8').replace('Only ASCII here', 'Only ASCII here, Жизнь'));
    const u3 = (await audit(opts)).usage as unknown as UsageFileJson;
    const exact = await checkUsage(root, u3);
    expect(exact.issues.map((i) => `${i.severity} ${i.message}`)).toEqual([expect.stringMatching(/^warning Inter: Ж \(U\+0416\), .* drawn on \d+ page\(s\) came from the rest file$/)]);
    expect(exact.ok).toBe(true);
    expect((await checkUsage(root, u3, { strict: true })).ok).toBe(false);
  }, 300_000);
});
