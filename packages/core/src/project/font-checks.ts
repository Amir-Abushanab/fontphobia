// Font readiness checks in the site's own code (§6, found on principlestash.com):
// `document.fonts.load('1em Fraunces')` and `document.fonts.check('1em Fraunces')` without the text
// argument test the text " ". Before the split that loaded the whole font; after it, only the core
// file. Code that waits for fonts before showing text, measuring it or drawing it on a canvas would
// then go ahead while the page's extended characters are still loading. The fix passes the page's
// rendered text, so the call waits for exactly the files the page uses:
//   document.fonts.load('1em Fraunces', document.body?.innerText)
// `document.body?.innerText` is a string or undefined, so it type-checks under strict TypeScript,
// and before <body> exists (a script in <head>) it is undefined, which is the old behavior.
//
// Parsed, not pattern-matched: TypeScript, JSX/TSX and JavaScript, and the <script> blocks of
// .astro, .vue, .svelte and .html files, with @babel/parser.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';

export const PAGE_TEXT = 'document.body?.innerText';

export interface FontCheckCall {
  /** Project-relative, '/'-separated. */
  file: string;
  line: number;
  method: 'load' | 'check';
  /** The call as written, e.g. `document.fonts.load('1em Fraunces')`, and where it starts in the file. */
  call: string;
  start: number;
  /** Offset in the file where the second argument goes (after the first argument). */
  insertAt: number;
  /** false when the call already passes text (or something we can't extend, like a spread). */
  fixable: boolean;
}

const SCRIPT_EXT = /\.(m|c)?(j|t)sx?$/;
const COMPONENT_EXT = /\.(astro|vue|svelte|html?)$/;
const SKIP = new Set(['node_modules', '.git', '.fontphobia', 'dist', 'build', 'out', '_site', '.output', '.next', '.nuxt', '.svelte-kit', '.astro', '.vercel', '.netlify', '.turbo', 'coverage', 'public', 'static']);

interface Block { code: string; offset: number; ts: boolean; jsx: boolean }

/** The code to parse in one file: the whole file, or each <script> block of a component. */
function blocks(file: string, text: string): Block[] {
  if (SCRIPT_EXT.test(file)) {
    const ts = /\.(m|c)?tsx?$/.test(file);
    return [{ code: text, offset: 0, ts, jsx: /x$/.test(file) || !ts }];
  }
  const out: Block[] = [];
  // <script> blocks only: an .astro frontmatter runs on the server, where `document` doesn't exist.
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["']?(application\/(ld\+)?json|text\/(template|x-template|html))/i.test(attrs)) continue;
    const ts = /\blang\s*=\s*["']?ts/i.test(attrs) || (file.endsWith('.astro') && !/\bis:inline\b/.test(attrs)); // Astro bundles <script> as TypeScript
    out.push({ code: m[2]!, offset: m.index! + m[0].indexOf('>') + 1, ts, jsx: false });
  }
  return out;
}

type Node = { type: string; start: number; end: number; loc?: { start: { line: number } }; [k: string]: unknown };

const isDocument = (n: Node | undefined): boolean => !!n && ((n.type === 'Identifier' && n.name === 'document')
  || ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && (n.property as Node).type === 'Identifier' && (n.property as Node).name === 'document'
    && (n.object as Node).type === 'Identifier' && ['window', 'globalThis', 'self'].includes((n.object as Node).name as string)));
const propName = (n: Node): string | undefined => (n.computed ? ((n.property as Node).type === 'StringLiteral' ? ((n.property as Node).value as string) : undefined) : ((n.property as Node).name as string | undefined));
const isMember = (n: Node | undefined): n is Node => !!n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression');

/** `document.fonts.load(…)` / `.check(…)` calls in one block of code. */
function callsIn(b: Block, file: string, text: string): FontCheckCall[] {
  const plugins: ParserPlugin[] = [...(b.ts ? ['typescript' as const] : []), ...(b.jsx ? ['jsx' as const] : [])];
  let ast: Node;
  try {
    ast = parse(b.code, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true, plugins }) as unknown as Node;
  } catch { return []; } // not parseable even with recovery: skipped, never edited
  const out: FontCheckCall[] = [];
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    const node = n as Node;
    if (typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = node.callee as Node;
      const method = isMember(callee) ? propName(callee) : undefined;
      const fonts = isMember(callee) ? (callee.object as Node) : undefined;
      if ((method === 'load' || method === 'check') && isMember(fonts) && propName(fonts) === 'fonts' && isDocument(fonts.object as Node)) {
        const args = node.arguments as Node[];
        const first = args[0];
        out.push({
          file, line: text.slice(0, b.offset + node.start).split('\n').length, method,
          call: b.code.slice(node.start, node.end), start: b.offset + node.start, insertAt: b.offset + (first?.end ?? node.end),
          fixable: args.length === 1 && first!.type !== 'SpreadElement',
        });
      }
    }
    for (const k of Object.keys(node)) if (k !== 'loc' && k !== 'start' && k !== 'end' && k !== 'extra' && k !== 'leadingComments' && k !== 'trailingComments') visit(node[k]);
  };
  visit(ast);
  return out;
}

/** Every `document.fonts.load/check` call in the project's source (not its build output or dependencies). */
export function findFontCheckCalls(root: string, o: { maxFiles?: number; outputDirs?: string[] } = {}): FontCheckCall[] {
  const out: FontCheckCall[] = [];
  const skipRel = new Set((o.outputDirs ?? []).map((d) => d.replace(/\/$/, '')));
  let files = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (files > (o.maxFiles ?? 20_000)) return;
      const p = join(dir, name);
      const rel = relative(root, p).split(sep).join('/');
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP.has(name) && !skipRel.has(rel) && !name.startsWith('.')) walk(p); continue; }
      if ((!SCRIPT_EXT.test(name) && !COMPONENT_EXT.test(name)) || /\.d\.(m|c)?ts$/.test(name) || st.size > 2_000_000) continue;
      files++;
      const text = readFileSync(p, 'utf8');
      if (!text.includes('fonts')) continue;
      for (const b of blocks(name, text)) out.push(...callsIn(b, rel, text));
    }
  };
  walk(root);
  return out;
}

/** The edit that passes the page's text to a call (inserted after its first argument). */
export function fontCheckFix(c: FontCheckCall): { at: number; text: string; to: string } {
  const text = `, ${PAGE_TEXT}`;
  const k = c.insertAt - c.start;
  return { at: c.insertAt, text, to: c.call.slice(0, k) + text + c.call.slice(k) };
}
