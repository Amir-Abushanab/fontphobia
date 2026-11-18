// Edits are data (§6): a file, a byte range of its text and the replacement. `build` previews them
// as a diff, applies them together, and `revert` undoes them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainStyle, type Style } from '../report/style.ts';

export interface Edit {
  file: string;
  start: number;
  end: number;
  text: string;
  why: string;
}

/** Throws when two edits touch the same bytes (checked before anything is written). */
export function checkEdits(edits: Edit[]): void {
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, es] of byFile) {
    const sorted = [...es].toSorted((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++)
      if (
        sorted[i]!.start < sorted[i - 1]!.end ||
        (sorted[i]!.start === sorted[i - 1]!.start &&
          sorted[i]!.start === sorted[i]!.end &&
          sorted[i - 1]!.start === sorted[i - 1]!.end)
      )
        throw new Error(`Overlapping edits in ${file}: ${sorted[i - 1]!.why} and ${sorted[i]!.why}`);
  }
}

export function applyEdits(root: string, edits: Edit[]): string[] {
  checkEdits(edits);
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  const changed: string[] = [];
  for (const [file, es] of [...byFile].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const abs = join(root, file);
    let text = readFileSync(abs, 'utf8');
    const sorted = [...es].toSorted((a, b) => b.start - a.start);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i]!.end > sorted[i - 1]!.start) throw new Error(`Overlapping edits in ${file}`);
    const before = text;
    for (const e of sorted) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    if (text !== before) {
      writeFileSync(abs, text);
      changed.push(file);
    }
  }
  return changed;
}

/** Options for {@link formatEdits}. */
export interface FormatEditsOptions {
  style?: Style;
  /** Longer lines are shortened (a long unicode-range keeps its first ranges and a count). */
  width?: number;
  /** Unchanged lines kept around each change; longer runs are folded. */
  context?: number;
}

/**
 * The edits as a line diff: `-` removed, `+` added, unchanged lines indented. `maxLines`: lines shown
 * per edit. `before`: the files' text before the edits (when they're already written).
 */
export function formatEdits(
  root: string,
  edits: Edit[],
  maxLines = 40,
  before?: Map<string, string>,
  o: FormatEditsOptions = {},
): string {
  const s = o.style ?? plainStyle;
  const width = o.width ?? 100;
  const context = o.context ?? 2;
  const L: string[] = [];
  for (const e of [...edits].toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start))) {
    const text = before?.get(e.file) ?? readFileSync(join(root, e.file), 'utf8');
    const line = text.slice(0, e.start).split('\n').length;
    if (L.length) L.push('');
    L.push(`${s.bold(s.cyan(`${e.file}:${line}`))}  ${s.dim(`(${e.why})`)}`);
    const ops = foldContext(diffLines(splitLines(text.slice(e.start, e.end)), splitLines(e.text)), context);
    const shown = ops.slice(0, maxLines);
    for (const op of shown)
      L.push(
        op.kind === 'fold'
          ? s.dim(`  ⋯ ${op.n} unchanged line${op.n === 1 ? '' : 's'}`)
          : op.kind === 'del'
            ? s.red(`- ${shorten(op.line, width)}`)
            : op.kind === 'add'
              ? s.green(`+ ${shorten(op.line, width)}`)
              : s.dim(`  ${shorten(op.line, width)}`),
      );
    if (ops.length > shown.length) L.push(s.dim(`  … ${ops.length - shown.length} more lines`));
  }
  return L.join('\n');
}

const splitLines = (t: string) => (t === '' ? [] : t.split(/\r?\n/));

type DiffOp = { kind: 'same' | 'del' | 'add'; line: string } | { kind: 'fold'; n: number };

/**
 * A line diff by longest common subsequence. Kept lines match as late as possible (rules added
 * before a declaration read as additions, then the declaration), and a changed line reads as its
 * removal, then its addition.
 */
function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length * b.length > 4_000_000)
    return [...a.map((line) => ({ kind: 'del' as const, line })), ...b.map((line) => ({ kind: 'add' as const, line }))];
  // lcs[i * w + j]: the longest common subsequence of a[i:] and b[j:].
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const out: DiffOp[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    const here = lcs[i * w + j]!;
    const skipB = lcs[i * w + j + 1] ?? 0;
    const skipA = lcs[(i + 1) * w + j] ?? 0;
    if (i < a.length && j < b.length && a[i] === b[j] && skipB < here) {
      out.push({ kind: 'same', line: a[i++]! });
      j++;
    } else if (i < a.length && (j === b.length || (a[i] !== b[j] && skipA === here)))
      out.push({ kind: 'del', line: a[i++]! });
    else out.push({ kind: 'add', line: b[j++]! });
  }
  return out;
}

/** Runs of unchanged lines longer than `context` on each side of a change become one fold. */
function foldContext(ops: DiffOp[], context: number): DiffOp[] {
  const out: DiffOp[] = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i]!.kind !== 'same') {
      out.push(ops[i++]!);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j]!.kind === 'same') j++;
    const keepBefore = i === 0 ? 0 : context,
      keepAfter = j === ops.length ? 0 : context;
    if (j - i > keepBefore + keepAfter + 1) {
      out.push(...ops.slice(i, i + keepBefore), { kind: 'fold', n: j - i - keepBefore - keepAfter });
      out.push(...ops.slice(j - keepAfter, j));
    } else out.push(...ops.slice(i, j));
    i = j;
  }
  return out;
}

/** A line cut to `width` characters; a long unicode-range keeps its first ranges and a count. */
function shorten(line: string, width: number): string {
  if (line.length <= width) return line;
  const m = line.match(/^(\s*unicode-range:\s*)([^;]*)(;?.*)$/);
  if (m) {
    const ranges = m[2]!.split(/\s*,\s*/);
    let head = '';
    let n = 0;
    while (n < ranges.length && (m[1] + head + ranges[n]).length < width - 24) head += (n ? ', ' : '') + ranges[n++];
    if (n < ranges.length)
      return `${m[1]}${head}, … ${ranges.length - n} more range${ranges.length - n === 1 ? '' : 's'}${m[3]}`;
  }
  return line.slice(0, width - 1) + '…';
}
