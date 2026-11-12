// build when things go wrong: a write failing part-way, Sass and Less comments in @font-face, a
// stylesheet edited since the audit, and one face failing among several.
import { chmodSync, closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProject, checkCss, createOverlay, findBlock, readManifest, revertProject, type UsageFileJson, type VerifyFinding } from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-robust-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const OUTPUT = /\.(core|ext|rest)\.[0-9a-f]{8}\.woff2$/;

/** Every file's sha256 and every folder, so a folder left behind shows too. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name), r = relative(dir, p).split(sep).join('/'); if (e.isDirectory()) { out[r + '/'] = 'dir'; walk(p); } else out[r] = sha(p); } };
  walk(dir);
  return out;
}
const withoutOutputs = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).filter(([f]) => !OUTPUT.test(f)));

function site(name: string) {
  const root = join(tmp, name);
  cpSync(join(repo, 'fixtures/sites/static-css'), root, { recursive: true });
  mkdirSync(join(root, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) cpSync(join(repo, 'fixtures/fonts', f), join(root, 'fonts', f));
  return root;
}
const usage = JSON.parse(readFileSync(join(repo, 'fixtures/plans/static-css/usage.json'), 'utf8')) as UsageFileJson;
/** The usage with only these faces (planning fewer faces keeps the tests quick). */
const only = (ids: string[], u = usage): UsageFileJson => ({ ...structuredClone(u), faces: Object.fromEntries(ids.map((id) => [id, structuredClone(u.faces[id]!)])) });

describe('build --write is all or nothing', () => {
  it('a write failing part-way changes nothing; the retry, then revert, gets back every file', async (ctx) => {
    const root = site('atomic');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/fonts.ts'), "export const ready = () => document.fonts.load('1em Inter');\n");
    const before = snapshot(root);
    // styles.css is the last file edited: fonts, index.html (the preload) and src/fonts.ts come first.
    chmodSync(join(root, 'styles.css'), 0o444);
    let writable = true;
    try { closeSync(openSync(join(root, 'styles.css'), 'r+')); } catch { writable = false; }
    if (writable) { chmodSync(join(root, 'styles.css'), 0o644); ctx.skip(); return; } // root, or a file system without modes
    const u = only(['deja-400-normal', 'inter-100-900-normal']);
    await expect(buildProject(root, u, {}, { version: '1', write: true })).rejects.toThrow(/styles\.css.*Nothing was changed/s);
    chmodSync(join(root, 'styles.css'), 0o644);
    expect(snapshot(root)).toEqual(before);

    const r = await buildProject(root, u, {}, { version: '1', write: true });
    expect(r.edits.map((e) => e.file).toSorted()).toEqual(['index.html', 'src/fonts.ts', 'styles.css', 'styles.css']);
    expect(readManifest(root)!.fontChecks).toHaveLength(1);
    expect(readManifest(root)!.entries['inter-100-900-normal']!.preloads).toHaveLength(1);
    expect(revertProject(root, { write: true }).problems).toEqual([]);
    expect(withoutOutputs(snapshot(root))).toEqual(before);
  }, 300_000);
});

describe('Sass and Less stylesheets', () => {
  for (const [ext, comment] of [['scss', '// code font'], ['less', '// code font']] as const) {
    it(`a .${ext} @font-face with a \`//\` comment builds, checks and reverts byte for byte`, async () => {
      const root = site(`syntax-${ext}`);
      const css = readFileSync(join(root, 'styles.css'), 'utf8').replace("font-family: 'Deja';\n", `font-family: 'Deja'; ${comment}\n`);
      rmSync(join(root, 'styles.css'));
      writeFileSync(join(root, `styles.${ext}`), css);
      const u = only(['deja-400-normal']);
      u.faces['deja-400-normal']!.source.file = `styles.${ext}`;
      const before = snapshot(root);
      const r = await buildProject(root, u, {}, { version: '1', write: true });
      expect(r.notWritten).toEqual([]);
      const out = readFileSync(join(root, `styles.${ext}`), 'utf8');
      const span = findBlock(out, 'deja-400-normal')!;
      expect(out.slice(span.start, span.end).match(/\/\/ code font/g)).toHaveLength(3);
      const m = readManifest(root)!;
      const e = m.entries['deja-400-normal']!;
      const findings: string[] = [];
      checkCss(root, e, (_k, _s: VerifyFinding['severity'], msg) => findings.push(msg));
      expect(findings).toEqual([]);
      // verify's overlay swaps the rules in the compiled CSS (comments gone) back to the original.
      const compiled = out.slice(span.start, span.end).replace(/ \/\/ code font/g, '');
      const restored = createOverlay(m).restoreCss(compiled);
      expect(restored).toContain('/__fontphobia/before/');
      expect(restored).not.toContain('woff2');
      expect(revertProject(root, { write: true }).problems).toEqual([]);
      expect(withoutOutputs(snapshot(root))).toEqual(before);
    }, 300_000);
  }
});

describe('the stylesheet changed since the audit', () => {
  const inter = only(['inter-100-900-italic', 'inter-100-900-normal']);
  const ruleOf = (root: string, r: Awaited<ReturnType<typeof buildProject>>) => Object.fromEntries(r.edits.filter((e) => e.file === 'styles.css').map((e) => [e.why.split(':')[0], /font-style: (\w+)/.exec(readFileSync(join(root, 'styles.css'), 'utf8').slice(e.start, e.end))?.[1]]));

  it('lines added at the top: each face still gets its own rule', async () => {
    const root = site('lines-added');
    const p = join(root, 'styles.css');
    writeFileSync(p, '/* a */\n/* b */\n/* c */\n/* d */\n/* e */\n' + readFileSync(p, 'utf8'));
    const r = await buildProject(root, inter, {}, { version: '1' });
    expect(r.notWritten).toEqual([]);
    expect(ruleOf(root, r)).toEqual({ 'inter-100-900-italic': 'italic', 'inter-100-900-normal': 'normal' });
  }, 300_000);

  it('the normal and italic rules swapped: matched by descriptors, not by line', async () => {
    const root = site('lines-swapped');
    const p = join(root, 'styles.css');
    const css = readFileSync(p, 'utf8');
    const [a, b] = [...css.matchAll(/@font-face \{[^}]*\}\n/g)].map((m) => m[0]);
    writeFileSync(p, css.replace(a! + b!, b! + a!));
    const r = await buildProject(root, inter, {}, { version: '1' });
    expect(r.notWritten).toEqual([]);
    expect(ruleOf(root, r)).toEqual({ 'inter-100-900-italic': 'italic', 'inter-100-900-normal': 'normal' });
  }, 300_000);

  it("a face whose rule no longer matches, or two faces on one rule, aren't written and say to rerun audit", async () => {
    const root = site('lines-gone');
    const p = join(root, 'styles.css');
    writeFileSync(p, readFileSync(p, 'utf8').replace('font-style: italic;', 'font-style: oblique;'));
    const u = only(['deja-400-normal', 'inter-100-900-italic']);
    // A second face with the Deja rule's descriptors: both would land on that one rule.
    u.faces['deja-copy'] = structuredClone(u.faces['deja-400-normal']!);
    const r = await buildProject(root, u, {}, { version: '1' });
    expect(r.edits.filter((e) => e.file === 'styles.css')).toEqual([]);
    expect(r.notWritten.map((n) => n.id).toSorted()).toEqual(['deja-400-normal', 'deja-copy', 'inter-100-900-italic']);
    for (const n of r.notWritten) expect(n.reason).toMatch(/changed since the audit; rerun `fontphobia audit`/);
  }, 300_000);
});

describe('one face failing', () => {
  it("the stylesheet holding a face's block renamed after the build: that face isn't written, with why", async () => {
    const root = site('renamed');
    const u = only(['deja-400-normal']);
    await buildProject(root, u, {}, { version: '1', write: true });
    renameSync(join(root, 'styles.css'), join(root, 'main.css'));
    u.faces['deja-400-normal']!.source.file = 'main.css';
    const r = await buildProject(root, u, {}, { version: '1' });
    expect(r.notWritten).toEqual([{ id: 'deja-400-normal', reason: expect.stringMatching(/^styles\.css, which holds its marked block, is gone/) }]);
    expect(r.manifest.entries['deja-400-normal']!.stylesheet).toBe('styles.css'); // the earlier entry stays for revert
  }, 300_000);

  it("a font that can't be planned is skipped with its error; the other faces still build", async () => {
    const root = site('bad-font');
    const u = only(['deja-400-normal', 'inter-100-900-normal']);
    // Any error from planning one face does; a feature tag the subsetter refuses is a cheap one to cause.
    u.faces['deja-400-normal']!.features = [...u.faces['deja-400-normal']!.features, 'not a tag'];
    const r = await buildProject(root, u, {}, { version: '1', write: true });
    const deja = r.plan.faces.find((f) => f.id === 'deja-400-normal')!;
    expect(deja.status).toBe('skipped');
    expect(deja.reason).toBe('planning it failed: Bad feature tag "not a tag"');
    expect(r.plan.faces.find((f) => f.id === 'inter-100-900-normal')!.status).toBe('planned');
    expect(Object.keys(readManifest(root)!.entries)).toEqual(['inter-100-900-normal']);
    const css = readFileSync(join(root, 'styles.css'), 'utf8');
    expect(findBlock(css, 'deja-400-normal')).toBeUndefined();
    expect(findBlock(css, 'inter-100-900-normal')).toBeDefined();
  }, 300_000);
});
