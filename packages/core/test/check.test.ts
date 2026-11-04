// M6: `check` (§12) catches every out-of-date scenario on the static fixture, without a browser.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProject, checkProject, formatCheck, htmlText, scriptStrings, type UsageFileJson } from '../src/index.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-check-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const usage = JSON.parse(readFileSync(join(repo, 'fixtures/plans/static-css/usage.json'), 'utf8')) as UsageFileJson;

async function built(name: string, allow: string[] = []) {
  const root = join(tmp, name);
  cpSync(join(repo, 'fixtures/sites/static-css'), root, { recursive: true });
  mkdirSync(join(root, 'fonts'));
  for (const f of ['InterVariable.ttf', 'DejaVuSans.ttf', 'Inter-Regular-hinted.woff2']) cpSync(join(repo, 'fixtures/fonts', f), join(root, 'fonts', f));
  await buildProject(root, usage, { allow }, { version: '1.2.3', write: true });
  return root;
}
const kinds = async (root: string) => (await checkProject({ root, usage })).issues.map((i) => `${i.kind}: ${i.message}`);

describe('check (§12)', () => {
  it('passes right after a build, and names the command to run', async () => {
    const root = await built('fresh');
    const r = await checkProject({ root, usage });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toMatchObject({ entries: 3, outputs: 9 });
    expect(r.checked.textFiles).toBeGreaterThanOrEqual(3);
    expect(r.command).toBe('npx fontphobia@1.2.3 --write'); // no lockfile: npm
    expect(formatCheck(r)).toMatch(/up to date/);
  }, 300_000);

  it('catches new characters in content, a changed source font, a new @font-face, and a feature the subsets dropped', async () => {
    const root = await built('stale');
    // Cyrillic: Inter has it, but it's only in the rest file.
    const about = join(root, 'about/index.html');
    writeFileSync(about, readFileSync(about, 'utf8').replace('Only ASCII here', 'Only ASCII here, Жизнь'));
    expect((await kinds(root)).join('\n')).toMatch(/^chars: Inter: Ж \(U\+0416\).* would load the rest file \(in about\/index\.html\)/m);
    // It still renders (the rest file has it): a warning, which fails only with strict.
    const lazy = await checkProject({ root, usage });
    expect(lazy.issues.map((i) => i.severity)).toEqual(['warning']);
    expect(lazy.ok).toBe(true);
    expect(formatCheck(lazy)).toMatch(/renders as built, but this downloads more than it should/);
    expect((await checkProject({ root, usage, strict: true })).ok).toBe(false);

    appendFileSync(join(root, 'styles.css'), "\n@font-face { font-family: 'New'; src: url('./fonts/Inter-Regular-hinted.woff2') format('woff2'); }\n.alt { font-family: Inter; font-feature-settings: 'ss02'; }\n");
    const k = (await kinds(root)).join('\n');
    expect(k).toMatch(/^face: an @font-face for New in styles\.css was added$/m);
    expect(k).toMatch(/^feature: styles\.css turns on 'ss02', which Inter's subsets don't keep$/m);

    const src = join(root, 'fonts/DejaVuSans.ttf');
    const b = readFileSync(src); b[b.length - 1] = b[b.length - 1]! ^ 1; writeFileSync(src, b);
    expect((await kinds(root)).join('\n')).toMatch(/^source: fonts\/DejaVuSans\.ttf changed since the build$/m);
  }, 300_000);

  it('with limit-axes, catches a weight outside the kept range (150, below it; @media print asks for 900)', async () => {
    const root = await built('axes', ['limit-axes']);
    expect(await kinds(root)).toEqual([]);
    appendFileSync(join(root, 'styles.css'), '\n.lighter { font-family: Inter; font-weight: 150; }\n');
    expect((await kinds(root)).join('\n')).toMatch(/^axis: styles\.css asks for wght 150, outside Inter's subsets \(\d+–\d+; limit-axes\)$/m);
  }, 300_000);

  it('reads rendered text from HTML and string literals from scripts', () => {
    expect(htmlText('<p>a&amp;b &#x2192; &mdash;</p><script>"ж"</script><img alt="Ω"><style>.q::before{content:"\\201C"}</style>')).toMatch(/a&b → —.*Ω.*“/s);
    expect(htmlText('<script>const s = "ж"</script>')).not.toContain('ж');
    expect(scriptStrings('const a = "ünï", b = \'\\u00e9\', c = `ok`;')).toBe('ünï é');
  });
});
