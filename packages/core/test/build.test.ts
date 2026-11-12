// M4: build --write for the css adapter, the manifest and revert. Runs on a copy of the static
// fixture with its committed usage.json, so no browser is needed.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildProject, cssBlock, findBlock, generatedFaces, MANIFEST_FILE, nameStrings, readManifest, renameTable, revertProject, subsetFont, toSfnt, withTables,
  type UsageFileJson,
} from '../src/index.ts';
import { fixture } from './helpers.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-build-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p).split(sep).join('/')] = sha(p); } };
  walk(dir);
  return out;
}

function site(name: string) {
  const root = join(tmp, name);
  cpSync(join(repo, 'fixtures/sites/static-css'), root, { recursive: true });
  mkdirSync(join(root, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) cpSync(join(repo, 'fixtures/fonts', f), join(root, 'fonts', f));
  return root;
}
const usage = JSON.parse(readFileSync(join(repo, 'fixtures/plans/static-css/usage.json'), 'utf8')) as UsageFileJson;

describe('build --write (css adapter, §9)', () => {
  it('makes document.fonts.load/check in the site code wait for the browser’s own loads; revert puts the calls back; check warns about new ones', async () => {
    const root = site('font-checks');
    const code = `const faces: string[] = ['1em Inter'];\nexport const ready = () => Promise.all(faces.map((f) => document.fonts.load(f))).then(() => document.fonts.check('1em Inter'));\n`;
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/fonts.ts'), code);
    const before = snapshot(root);
    const preview = await buildProject(root, usage, {}, { version: '1' });
    expect(preview.edits.filter((e) => e.file === 'src/fonts.ts').map((e) => e.text)).toEqual(['document.fonts.load(f).then((loaded) => document.fonts.ready.then(() => loaded))', "(document.fonts.check('1em Inter') && document.fonts.status === 'loaded')"]);
    await buildProject(root, usage, {}, { version: '1', write: true });
    expect(readFileSync(join(root, 'src/fonts.ts'), 'utf8')).toBe(code.replace('document.fonts.load(f)', 'document.fonts.load(f).then((loaded) => document.fonts.ready.then(() => loaded))').replace("document.fonts.check('1em Inter')", "(document.fonts.check('1em Inter') && document.fonts.status === 'loaded')"));
    expect(readManifest(root)!.fontChecks).toHaveLength(2);
    // A second build finds them fixed and keeps the records for revert.
    expect((await buildProject(root, usage, {}, { version: '1', write: true })).unchanged).toBe(true);
    expect(readManifest(root)!.fontChecks).toHaveLength(2);
    // A call added later: check warns.
    writeFileSync(join(root, 'src/late.js'), "document.fonts.load('1em Inter');\n");
    const { checkProject } = await import('../src/index.ts');
    const c = await checkProject({ root, outputDir: root });
    expect(c.issues.filter((i) => i.file === 'src/late.js').map((i) => i.severity)).toEqual(['warning']);
    // A usage.json from another audit (no face in common with the manifest) isn't used.
    const stale = await checkProject({ root, outputDir: root, usage: { ...usage, faces: { 'other-400-normal-abc123': usage.faces[Object.keys(usage.faces)[0]!]! } } as UsageFileJson });
    expect(stale.notes).toContainEqual(expect.stringMatching(/^usage\.json is from a different audit/));
    rmSync(join(root, 'src/late.js'));
    revertProject(root, { write: true });
    const after = snapshot(root);
    for (const f of Object.keys(after)) if (/\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/.test(f)) delete after[f];
    expect(after).toEqual(before);
  }, 300_000);

  it('writes the planned files and marked blocks, changes nothing the second time, and reverts byte for byte', async () => {
    const root = site('roundtrip');
    const before = snapshot(root);
    const preview = await buildProject(root, usage, {}, { version: '9.9.9' });
    expect(snapshot(root)).toEqual(before); // a preview writes nothing
    expect(preview.unchanged).toBe(false);
    expect(preview.notWritten).toEqual([]);

    const r = await buildProject(root, usage, {}, { version: '9.9.9', write: true });
    const css = readFileSync(join(root, 'styles.css'), 'utf8');
    expect(css.match(/fontphobia:begin/g)).toHaveLength(3);
    // Every planned file is on disk with the planned bytes and named by them.
    for (const f of r.plan.faces.flatMap((x) => x.files ?? [])) {
      const p = join(root, 'fonts', f.name);
      expect(sha(p)).toBe(f.sha256);
      expect(f.name).toContain(f.sha256.slice(0, 8));
      expect(css).toContain(`url('./fonts/${f.name}') format('woff2')`);
    }
    // Descriptors as written; src and unicode-range replaced.
    const block = css.slice(findBlock(css, 'inter-100-900-italic')!.start, findBlock(css, 'inter-100-900-italic')!.end);
    expect(block.match(/font-style: italic;/g)).toHaveLength(3);
    expect(block.match(/The same file registered as the italic face/g)).toHaveLength(3);
    expect(block).not.toContain('InterVariable.ttf');
    // The source preload now loads the core of the face that draws on most pages.
    const normalCore = r.plan.faces.find((f) => f.id === 'inter-100-900-normal')!.files!.find((f) => f.role === 'core')!.name;
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain(`href="./fonts/${normalCore}"`);
    const m = readManifest(root)!;
    expect(Object.keys(m.entries).toSorted()).toEqual(['deja-400-normal', 'inter-100-900-italic', 'inter-100-900-normal']);
    expect(m.entries['deja-400-normal']!.declaration).toBe("@font-face {\n  font-family: 'Deja';\n  src: url('./fonts/DejaVuSans.ttf') format('truetype');\n  font-display: swap;\n}");
    expect([...generatedFaces(m).keys()]).toHaveLength(9);

    const written = snapshot(root);
    const again = await buildProject(root, usage, {}, { version: '9.9.9', write: true });
    expect(again.unchanged).toBe(true);
    expect(snapshot(root)).toEqual(written);

    const rv = revertProject(root, { write: true });
    expect(rv.problems).toEqual([]);
    expect(rv.files).toEqual(['index.html', 'styles.css']);
    const after = snapshot(root);
    for (const f of rv.fonts) { expect(after[f]).toBeDefined(); delete after[f]; }
    expect(after).toEqual(before);
    expect(existsSync(join(root, MANIFEST_FILE))).toBe(false);
  }, 300_000);

  it('an @font-face in an inline <style> next to its preload: the rule is split, the preload points at core', async () => {
    const root = site('inline-style');
    const css = readFileSync(join(root, 'styles.css'), 'utf8');
    const decl = css.slice(css.indexOf("@font-face {\n  font-family: 'Deja'"), css.indexOf('}', css.indexOf("font-family: 'Deja'")) + 1);
    writeFileSync(join(root, 'styles.css'), css.replace(decl + '\n', ''));
    const html = readFileSync(join(root, 'index.html'), 'utf8').replace('<link rel="stylesheet"', `<link rel="preload" href="./fonts/DejaVuSans.ttf" as="font" type="font/ttf" crossorigin>\n<style>\n${decl}\n</style>\n<link rel="stylesheet"`);
    writeFileSync(join(root, 'index.html'), html);
    const u = structuredClone(usage);
    u.faces['deja-400-normal']!.source = { ...u.faces['deja-400-normal']!.source, file: 'index.html', line: html.split('\n').findIndex((l) => l.startsWith('@font-face')) + 1 };
    const before = snapshot(root);
    const r = await buildProject(root, u, {}, { version: '1', write: true });
    const out = readFileSync(join(root, 'index.html'), 'utf8');
    const core = r.plan.faces.find((f) => f.id === 'deja-400-normal')!.files!.find((f) => f.role === 'core')!.name;
    expect(out).toContain(`<link rel="preload" href="./fonts/${core}" as="font"`);
    expect(out.match(/fontphobia:begin deja-400-normal/g)).toHaveLength(1);
    expect(out).not.toContain("url('./fonts/DejaVuSans.ttf')");
    revertProject(root, { write: true });
    const after = snapshot(root);
    for (const f of Object.keys(after)) if (/\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/.test(f)) delete after[f];
    expect(after).toEqual(before);
  }, 300_000);

  it('rebuilds after usage changes: new outputs, outdated ones deleted, revert still restores the original', async () => {
    const root = site('rebuild');
    const before = snapshot(root);
    await buildProject(root, usage, {}, { version: '1', write: true });
    const first = readManifest(root)!;
    const more = structuredClone(usage);
    more.faces['deja-400-normal']!.chars += ', U+3A9'; // Ω, now used
    const r = await buildProject(root, more, {}, { version: '1', write: true });
    expect(r.stale.length).toBeGreaterThan(0);
    for (const f of r.stale) expect(existsSync(join(root, f))).toBe(false);
    const deja = readManifest(root)!.entries['deja-400-normal']!;
    expect(deja.outputs.map((o) => o.sha256)).not.toEqual(first.entries['deja-400-normal']!.outputs.map((o) => o.sha256));
    expect(deja.declaration).toBe(first.entries['deja-400-normal']!.declaration);
    revertProject(root, { write: true });
    const after = snapshot(root);
    for (const f of Object.keys(after)) if (/\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/.test(f)) delete after[f];
    expect(after).toEqual(before);
  }, 300_000);

  it('keeps CRLF line endings and indentation inside @media', async () => {
    const root = site('crlf');
    const css = readFileSync(join(root, 'styles.css'), 'utf8');
    const deja = css.slice(css.indexOf("@font-face {\n  font-family: 'Deja'"));
    const decl = deja.slice(0, deja.indexOf('}') + 1);
    const wrapped = css.replace(decl, `@media screen {\n  ${decl.replace(/\n/g, '\n  ')}\n}`).replace(/\n/g, '\r\n');
    writeFileSync(join(root, 'styles.css'), wrapped);
    const u = structuredClone(usage);
    u.faces['deja-400-normal']!.source.line = wrapped.split('\r\n').findIndex((l) => l.includes("'Deja'")) ;
    await buildProject(root, u, {}, { version: '1', write: true });
    const out = readFileSync(join(root, 'styles.css'), 'utf8');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toMatch(/@media screen \{\r\n {2}\/\* fontphobia:begin deja-400-normal 1 [^\r\n]*\r\n {2}@font-face \{\r\n {4}font-family: 'Deja';/);
    revertProject(root, { write: true });
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toBe(wrapped);
  }, 300_000);
});

describe('css block', () => {
  it('keeps local(), quoting and variation format hints, and adds unicode-range', () => {
    const b = cssBlock({
      id: 'x', version: '1', indent: '', eol: '\n', sourceUrl: '/f/a.woff2',
      declaration: `@font-face { font-family: "A"; src: local("A Regular"), url("/f/a.woff2") format("woff2-variations"), url(/f/a.woff) format("woff"); font-weight: 100 900 }`,
      files: [{ url: '/f/a.core.1.woff2', unicodeRange: 'U+20-7E' }, { url: '/f/a.ext.2.woff2', unicodeRange: 'U+A0-FF' }],
      descriptors: { 'font-weight': '400 700' },
    });
    expect(b).toContain('src: local("A Regular"), url("/f/a.core.1.woff2") format("woff2-variations"); font-weight: 400 700; unicode-range: U+20-7E');
    expect(b).toContain('url("/f/a.ext.2.woff2")');
    expect(b).not.toContain('a.woff"');
    expect(b.startsWith('/* fontphobia:begin x 1 ')).toBe(true);
    expect(b.endsWith('/* fontphobia:end x */')).toBe(true);
  });
});

describe('renames (§11)', () => {
  it('rewrites the family in the internal names and keeps the license records', async () => {
    const src = await toSfnt(fixture('InterVariable.ttf'));
    const out = withTables(src, { name: renameTable(src, 'Inter', 'Intr Subset') });
    const a = nameStrings(src), b = nameStrings(out);
    expect(b.get(1)).toBe(a.get(1)!.replace('Inter', 'Intr Subset'));
    expect(b.get(6)).toBe(a.get(6)!.replace('Inter', 'IntrSubset'));
    for (const id of [0, 13, 14]) expect(b.get(id)).toBe(a.get(id));
    const r = await subsetFont(src, { unicodes: [0x41], rename: { from: 'Inter', to: 'Intr Subset' } });
    expect(nameStrings(r.decoded).get(4)).toContain('Intr Subset');
  });
});

describe('manual faces (§6.7)', () => {
  it('writes the subsets and prints the block to paste, editing nothing', async () => {
    const root = site('manual');
    const u = structuredClone(usage);
    u.faces['deja-400-normal']!.source = { ...u.faces['deja-400-normal']!.source, adapter: 'manual', note: 'computed URL' };
    const css = readFileSync(join(root, 'styles.css'), 'utf8');
    const r = await buildProject(root, u, {}, { version: '1', write: true });
    expect(r.snippets.map((s) => s.id)).toEqual(['deja-400-normal']);
    const sn = r.snippets[0]!.css;
    expect(sn).toMatch(/^\/\* fontphobia:begin deja-400-normal 1 /);
    expect(sn.match(/@font-face/g)).toHaveLength(3);
    expect(sn).toMatch(/font-family: 'Deja';/);
    expect(sn).toMatch(/src: url\('\.\/DejaVuSans\.core\.[0-9a-f]{8}\.woff2'\) format\('woff2'\)/);
    // The core rule keeps the original range (none here); the others carry theirs.
    expect(sn.match(/unicode-range/g)).toHaveLength(2);
    for (const f of r.plan.faces.find((x) => x.id === 'deja-400-normal')!.files!) expect(existsSync(join(root, 'fonts', f.name))).toBe(true);
    expect(r.edits.filter((e) => e.why.startsWith('deja'))).toEqual([]);
    expect(readFileSync(join(root, 'styles.css'), 'utf8').includes("font-family: 'Deja';\n  src: url('./fonts/DejaVuSans.ttf')")).toBe(css.includes("font-family: 'Deja';\n  src: url('./fonts/DejaVuSans.ttf')"));
    expect(readManifest(root)!.entries['deja-400-normal']).toBeUndefined();
  }, 300_000);
});
