// document.fonts.load/check calls without text (§6): found by parsing TypeScript, JSX/TSX, JavaScript
// and the <script> blocks of components, never by pattern; the fix type-checks under strict TS.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { findFontCheckCalls, fontCheckFix } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-fontchecks-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmp, 'p-'));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), t); }
  return root;
}
const apply = (text: string, calls: ReturnType<typeof findFontCheckCalls>) => {
  let out = text;
  for (const c of [...calls].filter((x) => x.fixable).sort((a, b) => b.start - a.start)) { const f = fontCheckFix(c); out = out.slice(0, f.start) + f.text + out.slice(f.end); }
  return out;
};

describe('font readiness checks', () => {
  it('finds the calls in TypeScript, TSX, JavaScript and component scripts, and nothing in strings or comments', () => {
    const root = project({
      'src/fonts.ts': `const faces: string[] = ['1em Fraunces'];\nexport async function ready<T>(x: T): Promise<T> {\n  await Promise.all(faces.map((f) => document.fonts.load(f)));\n  return x;\n}\nconst ok = document.fonts.check("1em Geist", "abc"); // already passes text\n// document.fonts.load('in a comment')\nconst s = "document.fonts.load('in a string')";\n`,
      'src/App.tsx': `export const App = () => { window.document.fonts.load(\`\${700} 1em Inter\`); return <div onClick={() => document.fonts?.check('1em Inter')}>hi</div>; };\n`,
      'src/legacy.js': `document.fonts.load('1em X',);\ndocument.fonts['check']('1em X');\nconst f = document.fonts.load;\n`,
      'src/components/Head.astro': `---\nconst x = document.fonts.load('server side, not run in the browser');\n---\n<script is:inline type="module">\n  for (const font of faces) document.fonts.load(font).catch(() => {});\n  if (faces.every((font) => document.fonts.check(font))) go();\n</script>\n<script>\n  const n: number = 1; document.fonts.load('1em A');\n</script>\n<script type="application/ld+json">{"document.fonts.load('x')": 1}</script>\n`,
      'src/Comp.vue': `<template><p>{{ x }}</p></template>\n<script setup lang="ts">\nconst x: string = 'a'; await document.fonts.load('1em V');\n</script>\n`,
      'src/Comp.svelte': `<script>\n  document.fonts.check('1em S');\n</script>\n<p>hi</p>\n`,
      'public/page.html': `<script>document.fonts.load('1em NotScanned')</script>`, // public/ holds served copies, not source
      'src/types.d.ts': `declare const y: ReturnType<typeof document.fonts.load>;`,
    });
    const calls = findFontCheckCalls(root);
    expect(calls.map((c) => `${c.file}:${c.line} ${c.method} ${c.fixable ? 'fix' : 'ok'} ${c.call}`)).toEqual([
      'src/App.tsx:1 load fix window.document.fonts.load(`${700} 1em Inter`)',
      'src/App.tsx:1 check fix document.fonts?.check(\'1em Inter\')',
      'src/Comp.svelte:2 check fix document.fonts.check(\'1em S\')',
      'src/Comp.vue:3 load fix document.fonts.load(\'1em V\')',
      'src/components/Head.astro:5 load fix document.fonts.load(font)',
      'src/components/Head.astro:6 check fix document.fonts.check(font)',
      'src/components/Head.astro:9 load fix document.fonts.load(\'1em A\')',
      'src/fonts.ts:3 load fix document.fonts.load(f)',
      'src/fonts.ts:6 check ok document.fonts.check("1em Geist", "abc")',
      'src/legacy.js:1 load fix document.fonts.load(\'1em X\',)',
      'src/legacy.js:2 check fix document.fonts[\'check\'](\'1em X\')',
    ]);
    expect(fontCheckFix(calls.find((c) => c.file === 'src/legacy.js')!).text).toBe("document.fonts.load('1em X',).then((faces) => document.fonts.ready.then(() => faces))");
    expect(fontCheckFix(calls.find((c) => c.method === 'check' && c.file === 'src/App.tsx')!).text).toBe("(document.fonts?.check('1em Inter') && document.fonts?.status === 'loaded')");
    expect(fontCheckFix(calls.find((c) => c.file === 'src/App.tsx' && c.method === 'load')!).text).toBe('window.document.fonts.load(`${700} 1em Inter`).then((faces) => window.document.fonts.ready.then(() => faces))');
  });

  it('recognizes calls it already fixed, so a rebuild changes nothing', () => {
    const code = `export const go = async (font: string) => { await document.fonts.load(font); return !document.fonts.check(font); };\n`;
    const root = project({ 'src/a.ts': code });
    const fixed = apply(code, findFontCheckCalls(root));
    expect(fixed).toBe("export const go = async (font: string) => { await document.fonts.load(font).then((faces) => document.fonts.ready.then(() => faces)); return !(document.fonts.check(font) && document.fonts.status === 'loaded'); };\n");
    writeFileSync(join(root, 'src/a.ts'), fixed);
    expect(findFontCheckCalls(root).map((c) => c.fixable)).toEqual([false, false]);
  });

  it('the fixed TypeScript and TSX type-check under strict mode with the DOM library', () => {
    const files: Record<string, string> = {
      'a.ts': `const faces: string[] = ['1em A'];\nexport async function f() { await Promise.all(faces.map((x) => document.fonts.load(x))); return document.fonts.check('1em A'); }\n`,
      'b.tsx': `export const C = () => <i onClick={() => void document.fonts.load('1em B')} />;\n`,
    };
    const root = project(files);
    const calls = findFontCheckCalls(root);
    const fixed = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, apply(t, calls.filter((c) => c.file === f))]));
    expect(fixed['a.ts']).toContain('document.fonts.load(x).then((faces) => document.fonts.ready.then(() => faces))');
    const host = ts.createCompilerHost({});
    const read = host.readFile.bind(host);
    host.readFile = (f) => (f.endsWith('a.ts') ? fixed['a.ts'] : f.endsWith('b.tsx') ? fixed['b.tsx'] : read(f));
    host.fileExists = ((exists) => (f: string) => f.endsWith('a.ts') || f.endsWith('b.tsx') || exists(f))(host.fileExists.bind(host));
    // A minimal JSX namespace, so the TSX check needs no React types.
    const jsx = 'declare namespace JSX { interface IntrinsicElements { [k: string]: { onClick?: () => void } } interface Element {} }';
    host.readFile = ((r) => (f: string) => (f.endsWith('jsx.d.ts') ? jsx : r(f)))(host.readFile);
    host.fileExists = ((e) => (f: string) => f.endsWith('jsx.d.ts') || e(f))(host.fileExists);
    const program = ts.createProgram(['a.ts', 'b.tsx', 'jsx.d.ts'].map((f) => join(root, f)), { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, skipLibCheck: true }, host);
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(errors).toEqual([]);
  });
});
