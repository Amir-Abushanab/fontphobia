// Edits are data (§6): a file, a byte range of its text and the replacement. `build` previews them
// as a diff, applies them together, and `revert` undoes them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** A small unified-style diff of each edit, for the preview. */
/** The edits as a diff. `before`: the files' text before the edits (when they're already written). */
export function formatEdits(root: string, edits: Edit[], maxLines = 12, before?: Map<string, string>): string {
  const L: string[] = [];
  for (const e of [...edits].toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start))) {
    const text = before?.get(e.file) ?? readFileSync(join(root, e.file), 'utf8');
    const line = text.slice(0, e.start).split('\n').length;
    L.push(`--- ${e.file}:${line}  (${e.why})`);
    const cut = (s: string, sign: string) => {
      const ls = s.split(/\r?\n/);
      return [
        ...ls.slice(0, maxLines).map((l) => `${sign} ${l}`),
        ...(ls.length > maxLines ? [`${sign} … ${ls.length - maxLines} more lines`] : []),
      ];
    };
    L.push(...cut(text.slice(e.start, e.end), '-'), ...cut(e.text, '+'));
  }
  return L.join('\n');
}
