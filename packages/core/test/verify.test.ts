// M5, the deterministic layers of verify (§10.1–10.2), and the verifier's mutation tests (§15):
// each deliberate bug must make verify fail with the right cause.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProject, readManifest, verifyStatic, type Mutation, type UsageFileJson } from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-verify-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const usage = JSON.parse(readFileSync(join(repo, 'fixtures/plans/static-css/usage.json'), 'utf8')) as UsageFileJson;

async function built(name: string, mutation?: Mutation) {
  const root = join(tmp, name);
  cpSync(join(repo, 'fixtures/sites/static-css'), root, { recursive: true });
  mkdirSync(join(root, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) cpSync(join(repo, 'fixtures/fonts', f), join(root, 'fonts', f));
  await buildProject(root, usage, { mutation }, { version: '1', write: true });
  return root;
}
const regressions = (r: Awaited<ReturnType<typeof verifyStatic>>) => r.findings.filter((f) => f.severity === 'regression');

describe('verify: font level and shaping (§10.1–10.2)', () => {
  it('passes a clean build, with every stored word shaped identically', async () => {
    const root = await built('clean');
    const r = await verifyStatic(root, usage, readManifest(root)!);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    const inter = r.shaping.find((s) => s.id === 'inter-100-900-normal')!;
    expect(inter.cases).toBeGreaterThan(300);
    expect(inter.identical).toBe(inter.cases);
    expect(r.outputs.size).toBe(9);
  }, 120_000);

  it('catches outputs edited or deleted after the build', async () => {
    const root = await built('tampered');
    const m = readManifest(root)!;
    const [a, b] = m.entries['deja-400-normal']!.outputs;
    writeFileSync(join(root, a!.file), readFileSync(join(root, b!.file)));
    rmSync(join(root, m.entries['inter-100-900-italic']!.outputs[0]!.file));
    const r = await verifyStatic(root, usage, m);
    expect(r.ok).toBe(false);
    expect(regressions(r).map((f) => f.message).join('\n')).toMatch(/changed since the build[\s\S]*is missing/);
  }, 120_000);
});

describe('verify: mutation tests (§15)', () => {
  const face = 'inter-100-900-normal';
  const cases: [string, Mutation, RegExp, string][] = [
    ['drop a used character', { face, kind: 'drop-char', cp: 0xe9 }, /U\+00E9 aren't in any output/, 'coverage'],
    ['drop a used feature', { face, kind: 'drop-feature', tag: 'tnum' }, /tnum=1/, 'shaping'],
    ['pin an axis that something overrides', { face, kind: 'pin-axis', tag: 'wght', value: 400 }, /wght=(300|700)/, 'shaping'],
    ['give the extended file its own family name', { face, kind: 'ext-family', family: 'Inter Ext' }, /ext rule has font-family "Inter Ext"/, 'css'],
    ['move a combining mark out of core', { face, kind: 'mark-out-of-core' }, /café|naïve|glyph count/, 'shaping'],
  ];
  for (const [name, mutation, cause, kind] of cases) {
    it(name, async () => {
      const root = await built(mutation.kind, mutation);
      const r = await verifyStatic(root, usage, readManifest(root)!);
      expect(r.ok).toBe(false);
      const hit = regressions(r).filter((f) => f.id === face && f.kind === kind);
      expect(hit.map((f) => f.message).join('\n')).toMatch(cause);
      // Only the mutated face fails.
      expect(regressions(r).every((f) => f.id === face)).toBe(true);
    }, 120_000);
  }
});
