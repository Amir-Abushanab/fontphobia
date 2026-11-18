import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatEdits, type Style } from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'fontphobia-edits-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rule = (src: string, range?: string) =>
  [
    '@font-face {',
    "  font-family: 'Inter';",
    `  src: url('${src}') format('woff2');`,
    '  font-weight: 100 900;',
    '  font-display: swap;',
    ...(range ? [`  unicode-range: ${range};`] : []),
    '}',
  ].join('\n');

describe('formatEdits', () => {
  const before = rule('./Inter.woff2');
  writeFileSync(join(root, 'a.css'), `body { margin: 0 }\n${before}\n`);
  const start = 'body { margin: 0 }\n'.length;
  const longRange = Array.from(
    { length: 60 },
    (_, i) => `U+${(0x400 + i * 4).toString(16).toUpperCase()}-${(0x401 + i * 4).toString(16).toUpperCase()}`,
  ).join(', ');
  const edit = {
    file: 'a.css',
    start,
    end: start + before.length,
    text: [rule('./Inter.rest.woff2', longRange), rule('./Inter.core.woff2')].join('\n'),
    why: 'inter: core + rest',
  };

  it('diffs by line: kept lines are context, the changed src line is a removal and an addition', () => {
    const out = formatEdits(root, [edit]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('a.css:2  (inter: core + rest)');
    // The original rule matches the last new rule (core), so the rest rule reads as an addition before it.
    expect(lines).toContain("-   src: url('./Inter.woff2') format('woff2');");
    expect(lines).toContain("+   src: url('./Inter.core.woff2') format('woff2');");
    expect(lines.indexOf("-   src: url('./Inter.woff2') format('woff2');")).toBeLessThan(
      lines.indexOf("+   src: url('./Inter.core.woff2') format('woff2');"),
    );
    expect(lines.filter((l) => l.startsWith('-'))).toHaveLength(1);
    expect(lines).toContain("    font-family: 'Inter';");
  });

  it('shortens a long unicode-range to its first ranges and a count', () => {
    const line = formatEdits(root, [edit], 40, undefined, { width: 80 })
      .split('\n')
      .find((l) => l.includes('unicode-range'))!;
    expect(line.length).toBeLessThanOrEqual(82);
    expect(line).toMatch(/^\+ {3}unicode-range: U\+400-401, .*, … \d+ more ranges;$/);
  });

  it('folds long runs of unchanged lines and caps the lines shown', () => {
    const many = Array.from({ length: 30 }, (_, i) => `  --x${i}: ${i};`).join('\n');
    writeFileSync(join(root, 'b.css'), `:root {\n${many}\n}\n`);
    const out = formatEdits(root, [
      {
        file: 'b.css',
        start: 0,
        end: `:root {\n${many}\n}`.length,
        text: `:root {\n${many}\n  --y: 1;\n}`,
        why: 'add',
      },
    ]);
    expect(out).toMatch(/⋯ 29 unchanged lines/);
    expect(out).toContain('+   --y: 1;');
    const capped = formatEdits(root, [edit], 5);
    expect(capped).toMatch(/… \d+ more lines$/);
  });

  it('applies the style to each kind of line', () => {
    const tag = (t: string) => (s: string) => `<${t}>${s}</${t}>`;
    const style: Style = {
      bold: tag('b'),
      dim: tag('d'),
      red: tag('r'),
      green: tag('g'),
      yellow: tag('y'),
      cyan: tag('c'),
      magenta: tag('m'),
    };
    const out = formatEdits(root, [edit], 40, undefined, { style });
    expect(out).toContain('<b><c>a.css:2</c></b>');
    expect(out).toContain("<r>-   src: url('./Inter.woff2') format('woff2');</r>");
    expect(out).toContain("<d>    font-family: 'Inter';</d>");
  });
});
