// Pure parts of the browser stage of verify: no browser.
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { joinStrips, unexplainedLoad } from '../src/verify.ts';

describe('a long page captured in strips', () => {
  it('joins them top to bottom, row for row', () => {
    const strip = (height: number, value: number) => {
      const png = new PNG({ width: 2, height });
      png.data.fill(value);
      return png;
    };
    const out = joinStrips([strip(2, 10), strip(1, 20), strip(3, 30)]);
    expect([out.width, out.height]).toEqual([2, 6]);
    const rows = Array.from({ length: out.height }, (_, y) => out.data[y * out.width * 4]);
    expect(rows).toEqual([10, 10, 20, 30, 30, 30]);
  });
});

describe('a file that loaded where the audit recorded none of its characters', () => {
  const ref = { file: 'fonts/mono.ext.woff2', role: 'ext' };
  const node = (text: string) => ({ key: text, text, boxes: [] });

  it('names the character the page has now, with the words around it, and what to declare', () => {
    const message = unexplainedLoad(ref, new Set([0xb0]), [
      node('A long paragraph of plain text that says nothing about the weather at all.'),
      node('Local sky: Montreal · 9°C · 12:00 AM'),
    ]);
    expect(message).toContain('fonts/mono.ext.woff2 (ext) loaded, but the audit recorded none of its characters');
    expect(message).toMatch(/° \(U\+00B0\) in "[^"]*Montreal · 9°C · 12:00 AM"/);
    expect(message).not.toContain('long paragraph');
    expect(message).toContain('`extraText`');
  });

  it('says so when the text has none of them either', () => {
    const message = unexplainedLoad(ref, new Set([0xb0]), [node('Local sky')]);
    expect(message).toContain("the page's text has none now");
    expect(message).not.toContain('extraText');
  });
});
