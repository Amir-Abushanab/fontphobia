// `auto`: the built output is subset in place, without a manifest, in both modes. No browser here;
// the crawl mode takes the fixture's audited usage.json.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AutoVerifyError, autoSubset, formatAuto, parseStylesheet, type UsageFileJson } from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-auto-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const version = '1.2.3';

/** A built site: `files` by path, plus fixture fonts (and their licenses) copied to the given paths. */
function site(name: string, files: Record<string, string>, fonts: Record<string, string>) {
  const dir = join(tmp, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  for (const [rel, font] of Object.entries(fonts)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(repo, 'fixtures/fonts', font), join(dir, rel));
    const license = font.startsWith('DejaVu') ? 'DejaVu-LICENSE.txt' : 'Inter-LICENSE.txt';
    cpSync(join(repo, 'fixtures/fonts', license), join(dirname(join(dir, rel)), license));
  }
  return dir;
}
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');
/** The split rules a page carries at the end of its <head>. */
const inlined = (html: string) => html.match(/<style data-fontphobia>\n([\s\S]*?)<\/style><\/head>/)?.[1];
/** Every file of a directory, by path, for byte comparisons. */
function snapshot(dir: string, at = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, snapshot(dir, rel));
    else out[rel] = readFileSync(join(dir, rel)).toString('base64');
  }
  return out;
}

const FACE = `@font-face{font-family:Deja;src:url(fonts/DejaVuSans.ttf) format("truetype");font-display:swap}`;
const page = (body: string, head = '<link rel="stylesheet" href="/styles.css">') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

describe('auto, static (no browser)', () => {
  it('writes the split files, puts their rules last in each page’s <head>, and keeps the original rule as a bounded fallback', async () => {
    const dir = site(
      'static',
      {
        'styles.css': `${FACE}body{font-family:Deja,sans-serif}`,
        'index.html': page(
          '<p>Hello café</p>',
          '<link rel="preload" as="font" type="font/ttf" href="/fonts/DejaVuSans.ttf" crossorigin><link rel="stylesheet" href="/styles.css">',
        ),
        'about/index.html': page('<p>Über uns</p>'),
      },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const r = await autoSubset({ root: dir, outDir: dir, version });
    expect(r.mode).toBe('static');
    expect(r.faces.map((f) => f.id)).toEqual(['deja-400-normal']);
    expect(r.fonts.map((f) => f.file.replace(/\.[0-9a-f]{8}\./, '.'))).toEqual([
      'fonts/DejaVuSans.core.woff2',
      'fonts/DejaVuSans.ext.woff2',
      'fonts/DejaVuSans.rest.woff2',
    ]);
    for (const f of r.fonts) expect(existsSync(join(dir, f.file))).toBe(true);
    expect(r.checked).toMatchObject({ outputs: 3 });
    expect(r.checked!.words).toBeGreaterThan(0);

    // The rules: rest, extended, core, with the original descriptors and URLs from the site's root,
    // like the page's own stylesheet. Inline, so no stylesheet can load between them and the originals.
    const css = inlined(read(dir, 'index.html'))!;
    expect(r.inlined!.bytes).toBeGreaterThan(0);
    expect(readdirSync(dir).filter((n) => n.endsWith('.css'))).toEqual(['styles.css']);
    const rules = parseStylesheet(css).fontFaces;
    expect(rules.map((x) => x.src[0]!.url!.replace(/\.[0-9a-f]{8}\./, '.'))).toEqual([
      '/fonts/DejaVuSans.rest.woff2',
      '/fonts/DejaVuSans.ext.woff2',
      '/fonts/DejaVuSans.core.woff2',
    ]);
    for (const x of rules) expect(x.descriptors['font-display']).toBe('swap');
    expect(rules[2]!.descriptors['unicode-range']).toBeUndefined();

    // Last in every page's <head>.
    expect(inlined(read(dir, 'about/index.html'))).toBe(css);
    expect(r.linked).toBe(2);
    // The preload loads core now.
    expect(read(dir, 'index.html')).toMatch(
      /rel="preload" as="font" type="font\/woff2" href="\/fonts\/DejaVuSans\.core\.[0-9a-f]{8}\.woff2"/,
    );

    // The original rule is still there, with the font's own characters as its unicode-range and nothing else changed.
    const [orig] = parseStylesheet(read(dir, 'styles.css')).fontFaces;
    expect(orig!.src[0]!.url).toBe('fonts/DejaVuSans.ttf');
    expect(orig!.descriptors['unicode-range']).toMatch(/^U\+20-7E, /);
    expect(read(dir, 'styles.css').replace(/;unicode-range:[^}]*/, '')).toBe(
      `${FACE}body{font-family:Deja,sans-serif}`,
    );
    expect(existsSync(join(dir, 'fonts/DejaVuSans.ttf'))).toBe(true);
    // é and Ü are on pages: kept, outside the rest file.
    const rest = rules[0]!.unicodeRange;
    for (const c of [0xe9, 0xdc]) expect(rest.some(([a, b]) => c >= a && c <= b)).toBe(false);

    expect(formatAuto(r, 'dist')).toMatch(/1 face\(s\) subset in dist[\s\S]*Checked without a browser: 3 file\(s\)/);
    // The output is subset once per build.
    await expect(autoSubset({ root: dir, outDir: dir, version })).rejects.toThrow(/already subset/);
  }, 120_000);

  it('replaces a rule in a page’s own <style> in place, and adds no second copy', async () => {
    const dir = site(
      'inline',
      { 'index.html': page('<p>Hi</p>', `<style>${FACE}body{font-family:Deja}</style>`) },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const r = await autoSubset({ root: dir, outDir: dir, version });
    expect(r.inlined).toBeUndefined();
    const html = read(dir, 'index.html');
    expect(html).not.toContain('DejaVuSans.ttf');
    expect(html).toMatch(/fontphobia:begin deja-400-normal 1\.2\.3 \(generated by `fontphobia auto`\)/);
    expect(html.match(/url\(fonts\/DejaVuSans\.(rest|ext|core)\.[0-9a-f]{8}\.woff2\)/g)).toHaveLength(3);
    expect(html).toContain('body{font-family:Deja}</style>');
    // The marker in the page says it was subset.
    await expect(autoSubset({ root: dir, outDir: dir, version })).rejects.toThrow(/already subset/);
  }, 120_000);

  it('points React preload hints (Next) at the core file, in the page and in its payload files', async () => {
    const hint = ':HL["/fonts/DejaVuSans.ttf","font",{"crossOrigin":"","type":"font/ttf"}]';
    const other = ':HL["/fonts/Other.ttf","font",{"crossOrigin":"","type":"font/ttf"}]';
    const dir = site(
      'hints',
      {
        'styles.css': `${FACE}body{font-family:Deja}`,
        'index.html': page(
          `<p>Hi</p><script>self.__next_f.push([1,${JSON.stringify(`1${hint}\n2${other}\n`)}])</script>`,
        ),
        'index.txt': `1${hint}\n2${other}\n3:["$","p",null,{"children":"Hi"}]\n`,
      },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    await autoSubset({ root: dir, outDir: dir, version });
    const core =
      /:HL\["\/fonts\/DejaVuSans\.core\.[0-9a-f]{8}\.woff2","font",\{"crossOrigin":"","type":"font\/woff2"\}\]/;
    expect(read(dir, 'index.txt')).toMatch(core);
    expect(read(dir, 'index.txt')).toContain(other);
    expect(read(dir, 'index.txt')).toContain('3:["$","p",null,{"children":"Hi"}]');
    const html = read(dir, 'index.html');
    expect(html).not.toContain('DejaVuSans.ttf');
    expect(JSON.parse(html.match(/push\(\[1,(".*?")\]\)<\/script>/)![1]!)).toMatch(core);
  }, 120_000);

  it('rules: linked writes one stylesheet at the root and links it last instead', async () => {
    const dir = site(
      'linked',
      {
        'styles.css': `${FACE}body{font-family:Deja,sans-serif}`,
        'index.html': page('<p>Hello café</p>'),
        'about/index.html': page('<p>Über uns</p>'),
      },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const r = await autoSubset({ root: dir, outDir: dir, version, rules: 'linked' });
    expect(r.inlined).toBeUndefined();
    const sheet = r.stylesheet!.file;
    expect(sheet).toMatch(/^fontphobia\.[0-9a-f]{8}\.css$/);
    expect(
      parseStylesheet(read(dir, sheet)).fontFaces.map((x) => x.src[0]!.url!.replace(/\.[0-9a-f]{8}\./, '.')),
    ).toEqual(['fonts/DejaVuSans.rest.woff2', 'fonts/DejaVuSans.ext.woff2', 'fonts/DejaVuSans.core.woff2']);
    for (const p of ['index.html', 'about/index.html']) {
      expect(read(dir, p)).toContain(`<link rel="stylesheet" href="/${sheet}"></head>`);
      expect(read(dir, p)).not.toContain('<style data-fontphobia>');
    }
    expect(r.checked).toMatchObject({ outputs: 3 });
    expect(formatAuto(r, 'dist')).toContain(`${sheet} (`);
    await expect(autoSubset({ root: dir, outDir: dir, version })).rejects.toThrow(/already subset/);
  }, 120_000);

  it('leaves a font alone when its pages would not download less, and says so', async () => {
    // A font that holds little more than the page's own text: the core file of an earlier run.
    const big = site(
      'small-src',
      { 'styles.css': `${FACE}body{font-family:Deja}`, 'index.html': page('<p>Hello</p>') },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const core = (await autoSubset({ root: big, outDir: big, version })).fonts.find((f) => /\.core\./.test(f.file))!;
    const dir = site(
      'small',
      {
        'styles.css': '@font-face{font-family:Deja;src:url(fonts/Small.woff2) format("woff2")}body{font-family:Deja}',
        'index.html': page('<p>Hello</p>'),
      },
      {},
    );
    mkdirSync(join(dir, 'fonts'));
    cpSync(join(big, core.file), join(dir, 'fonts/Small.woff2'));
    cpSync(join(repo, 'fixtures/fonts/DejaVu-LICENSE.txt'), join(dir, 'fonts/DejaVu-LICENSE.txt'));
    const before = snapshot(dir);
    const r = await autoSubset({ root: dir, outDir: dir, version });
    expect(r.faces).toEqual([]);
    expect(r.skipped).toEqual([
      {
        id: 'deja-400-normal',
        family: 'Deja',
        reason: expect.stringMatching(
          /^splitting it would not make its pages download less \(.* → .* over 1 page\(s\)\)$/,
        ),
      },
    ]);
    expect(snapshot(dir)).toEqual(before);
  }, 120_000);

  it('gives a face with a unicode-range only the characters that range lets it draw', async () => {
    // Two slices of one family, as Fontsource writes them: each page character belongs to one of them.
    const slice = (range: string) =>
      `@font-face{font-family:Deja;src:url(fonts/DejaVuSans.ttf) format("truetype");unicode-range:${range}}`;
    const dir = site(
      'slices',
      {
        'styles.css': `${slice('U+100-17F')}${slice('U+0-FF')}${slice('U+400-45F')}body{font-family:Deja}`,
        'index.html': page('<p>Hello café, Łódź and őrült</p>'),
      },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const r = await autoSubset({ root: dir, outDir: dir, version });
    expect(r.faces.map((f) => f.id)).toEqual(['deja-400-normal', 'deja-400-normal-2']);
    expect(r.skipped).toEqual([
      { id: 'deja-400-normal-3', family: 'Deja', reason: 'no text in the output has a character of this face' },
    ]);
    const within = (id: string, lo: number, hi: number) => {
      const chars = r.usage.faces[id]!.chars.split(',').map((x) => x.trim().replace('U+', '').split('-'));
      for (const [a, b] of chars) {
        expect(parseInt(a!, 16)).toBeGreaterThanOrEqual(lo);
        expect(parseInt(b ?? a!, 16)).toBeLessThanOrEqual(hi);
      }
    };
    within('deja-400-normal', 0x100, 0x17f);
    within('deja-400-normal-2', 0, 0xff);
    // Words are shaped in the runs each face draws: "Łódź" is Ł, ó, d, ź to these two.
    expect(r.usage.faces['deja-400-normal']!.contexts[0]!.words.toSorted()).toEqual(['Ł', 'ő', 'ź']);
    expect(r.usage.faces['deja-400-normal-2']!.contexts[0]!.words.toSorted()).toEqual(['café,', 'rült', 'ód']);
    expect(r.checked!.outputs).toBe(r.fonts.length);
  }, 120_000);

  it('follows a base path, leaves a stylesheet pinned by an integrity hash unchanged, and skips what it cannot place', async () => {
    const dir = site(
      'base',
      {
        'assets/a.css': `@font-face{font-family:Deja;src:url(/docs/assets/DejaVuSans.ttf)}@media print{@font-face{font-family:Print;src:url(/docs/assets/DejaVuSans.ttf)}}@font-face{font-family:Nowhere;src:url(/docs/assets/DejaVuSans.ttf)}p{font-family:Deja,Print}`,
        'guide/index.html': page(
          '<p>Guide</p>',
          '<link rel="stylesheet" href="/docs/assets/a.css" integrity="sha384-x">',
        ),
      },
      { 'assets/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const css = read(dir, 'assets/a.css');
    const r = await autoSubset({ root: dir, outDir: dir, version });
    expect(r.faces.map((f) => f.id)).toEqual(['deja-400-normal']);
    expect(parseStylesheet(inlined(read(dir, 'guide/index.html'))!).fontFaces[0]!.src[0]!.url).toMatch(
      /^\/docs\/assets\/DejaVuSans\.rest\./,
    );
    expect(read(dir, 'assets/a.css')).toBe(css);
    expect(r.notes.join('\n')).toMatch(/assets\/a\.css is loaded with an integrity hash/);
    expect(r.skipped).toEqual([
      { id: 'nowhere-400-normal', family: 'Nowhere', reason: 'nothing in the output names this family' },
    ]);
  }, 120_000);

  it('a dry run writes nothing, and a project with committed subsets is refused', async () => {
    const dir = site(
      'dry',
      { 'styles.css': `${FACE}body{font-family:Deja}`, 'index.html': page('<p>Hi</p>') },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const before = snapshot(dir);
    const r = await autoSubset({ root: dir, outDir: dir, version, write: false });
    expect(r.written).toBe(false);
    expect(r.fonts).toHaveLength(3);
    expect(r.checked).toBeUndefined();
    expect(snapshot(dir)).toEqual(before);

    mkdirSync(join(dir, '.fontphobia'));
    writeFileSync(
      join(dir, '.fontphobia/manifest.json'),
      JSON.stringify({ version: 1, fontphobia: version, harfbuzz: 'x', chrome: 'x', entries: { a: {} } }),
    );
    await expect(autoSubset({ root: dir, outDir: dir, version })).rejects.toThrow(/committed subsets/);
  }, 120_000);

  it('puts the output back as it was when the written files fail their checks', async () => {
    const dir = site(
      'rollback',
      { 'styles.css': `${FACE}body{font-family:Deja}`, 'index.html': page('<p>Hello café</p>') },
      { 'fonts/DejaVuSans.ttf': 'DejaVuSans.ttf' },
    );
    const before = snapshot(dir);
    // The verifier's mutation: é is dropped from every file, so a used character has no file.
    const run = autoSubset({
      root: dir,
      outDir: dir,
      version,
      config: { mutation: { face: 'deja-400-normal', kind: 'drop-char', cp: 0xe9 } },
    });
    await expect(run).rejects.toThrow(AutoVerifyError);
    await expect(run).rejects.toThrow(/U\+00E9[\s\S]*fallback font|put back as it was/);
    expect(snapshot(dir)).toEqual(before);
  }, 120_000);
});

describe('auto, crawl (an audit’s usage)', () => {
  it('subsets each audited face from the output’s own files, and links only pages that draw one', async () => {
    const dir = join(tmp, 'crawl');
    cpSync(join(repo, 'fixtures/sites/static-css'), dir, { recursive: true });
    mkdirSync(join(dir, 'fonts'));
    for (const f of [
      'InterVariable.ttf',
      'DejaVuSans.ttf',
      'Inter-Regular-hinted.woff2',
      'Inter-LICENSE.txt',
      'DejaVu-LICENSE.txt',
    ])
      cpSync(join(repo, 'fixtures/fonts', f), join(dir, 'fonts', f));
    const usage = JSON.parse(read(repo, 'fixtures/plans/static-css/usage.json')) as UsageFileJson;
    const golden = JSON.parse(read(repo, 'fixtures/plans/static-css/plan.json')) as {
      faces: { id: string; files?: { name: string }[] }[];
    };
    const r = await autoSubset({ root: dir, outDir: dir, usage, version });
    expect(r.mode).toBe('crawl');
    expect(r.faces.map((f) => f.id).toSorted()).toEqual([
      'deja-400-normal',
      'inter-100-900-italic',
      'inter-100-900-normal',
    ]);
    // The same files the committed flow plans from this usage.
    expect(r.fonts.map((f) => f.file).toSorted()).toEqual(
      golden.faces.flatMap((f) => (f.files ?? []).map((x) => `fonts/${x.name}`)).toSorted(),
    );
    // Each page reaches the files its own way.
    expect(inlined(read(dir, 'index.html'))).toMatch(/url\('\.\/fonts\/InterVariable\.core\./);
    expect(inlined(read(dir, 'about/index.html'))).toMatch(/url\('\.\.\/fonts\/InterVariable\.core\./);
    expect(read(dir, 'index.html')).toMatch(
      /href="\.\/fonts\/InterVariable\.core\.[0-9a-f]{8}\.woff2" as="font" type="font\/woff2"/,
    );
    // Declared, used by no page: left alone, preload included.
    expect(read(dir, 'index.html')).toContain('href="./fonts/Inter-Regular-hinted.woff2"');
    expect(r.checked!.outputs).toBe(r.fonts.length);
  }, 300_000);
});
