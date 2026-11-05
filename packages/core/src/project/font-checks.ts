// Font readiness checks in the site's own code (§6, found on principlestash.com):
// `document.fonts.load('1em Fraunces')` and `document.fonts.check('1em Fraunces')` test the text " ".
// Before the split that meant the whole font; after it, only the core file. Code that waits for
// fonts before showing, measuring or drawing text would go ahead while the characters the page needs
// from the extended file are still loading. The fix waits for what the browser itself loads for the
// page, and asks for nothing more:
//   document.fonts.load(font)  →  document.fonts.load(font).then((f) => document.fonts.ready.then(() => f))
//   document.fonts.check(font) →  (document.fonts.check(font) && document.fonts.status === 'loaded')
// `ready` and `status` follow the browser's own loads, which layout drives: only the split files the
// rendered text needs. (Passing the page's text instead would fetch every file whose characters
// appear anywhere on the page, in any font.) Both keep their types under strict TypeScript.
//
// Parsed, not pattern-matched: TypeScript, JSX/TSX and JavaScript, and the <script> blocks of
// .astro, .vue, .svelte and .html files, with @babel/parser.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, type ParserPlugin } from '@babel/parser';


export interface FontCheckCall {
  /** Project-relative, '/'-separated. */
  file: string;
  line: number;
  method: 'load' | 'check';
  /** The call as written, e.g. `document.fonts.load('1em Fraunces')`, and where it is in the file. */
  call: string;
  start: number;
  end: number;
  /** The `document.fonts` part as written (`window.document.fonts`, `document.fonts?`…). */
  fonts: string;
  /** false when the call passes text (the author chose what to wait for) or was fixed already. */
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
  const src = (n: Node) => b.code.slice(n.start, n.end);
  // Already fixed: `load(…).then((…) => ….ready…)`, or `(check(…) && ….status === 'loaded')`.
  const fixedAlready = (method: string, node: Node, parent: Node | undefined, grand: Node | undefined) => (method === 'load'
    ? isMember(parent) && parent.object === node && propName(parent) === 'then' && !!grand && grand.callee === parent && /\.ready\b/.test(src(grand))
    : parent?.type === 'LogicalExpression' && parent.operator === '&&' && parent.left === node && /\.status\s*===\s*['"]loaded['"]/.test(src(parent.right as Node)));
  const visit = (n: unknown, parents: Node[]) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x, parents); return; }
    const node = n as Node;
    if (typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = node.callee as Node;
      const method = isMember(callee) ? propName(callee) : undefined;
      const fonts = isMember(callee) ? (callee.object as Node) : undefined;
      if ((method === 'load' || method === 'check') && isMember(fonts) && propName(fonts) === 'fonts' && isDocument(fonts.object as Node)) {
        const args = node.arguments as Node[];
        out.push({
          file, line: text.slice(0, b.offset + node.start).split('\n').length, method,
          call: src(node), start: b.offset + node.start, end: b.offset + node.end,
          fonts: src(fonts) + (callee.optional ? '?' : ''),
          fixable: args.length === 1 && args[0]!.type !== 'SpreadElement' && !fixedAlready(method, node, parents.at(-1), parents.at(-2)),
        });
      }
    }
    const next = [...parents, node];
    for (const k of Object.keys(node)) if (k !== 'loc' && k !== 'start' && k !== 'end' && k !== 'extra' && k !== 'leadingComments' && k !== 'trailingComments') visit(node[k], next);
  };
  visit(ast, []);
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

/** The call's replacement: wait for the browser's own loads (see the top of this file). */
export function fontCheckFix(c: FontCheckCall): { start: number; end: number; text: string } {
  const opt = c.fonts.endsWith('?') ? '?.' : '.';
  const text = c.method === 'load'
    ? `${c.call}${opt}then((faces) => ${c.fonts}.ready.then(() => faces))`
    : `(${c.call} && ${c.fonts}.status === 'loaded')`;
  return { start: c.start, end: c.end, text };
}
