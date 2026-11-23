// Config `extraText`: text no crawl sees is counted as drawn on the pages it is declared for.
import { describe, expect, it } from 'vitest';
import { withExtraText, type UsageFileJson } from '../src/index.ts';

const face = (family: string, chars: string) => ({
  family,
  chars,
  count: 0,
  contexts: [{ features: '', axes: {}, words: ['Local', 'sky'] }],
});
const usage = {
  faces: { mono: face('Geist Mono', 'U+41-5A'), serif: face('Fraunces', 'U+41-5A') },
  pages: {
    '/': { faces: { mono: 'U+41-5A', serif: 'U+41-5A' }, fonts: [], bytes: 0 },
    '/blog/a/': { faces: { serif: 'U+41-5A' }, fonts: [], bytes: 0 },
  },
} as unknown as UsageFileJson;

describe('extraText', () => {
  it('adds the text to every face the page draws, and leaves the audit as it was', () => {
    const r = withExtraText(usage, { '/': 'Montreal 9°C' });
    expect(r.unmatched).toEqual([]);
    expect(r.usage.pages['/']!.faces.mono).toBe('U+39, U+41-5A, U+61, U+65, U+6C, U+6E-6F, U+72, U+74, U+B0');
    expect(r.usage.pages['/']!.faces.serif).toBe(r.usage.pages['/']!.faces.mono);
    expect(r.usage.pages['/blog/a/']!.faces.serif).toBe('U+41-5A');
    expect(r.usage.faces.mono!.chars).toContain('U+B0');
    expect(r.usage.faces.mono!.count).toBe(35);
    expect(r.usage.faces.mono!.contexts[0]!.words).toEqual(['Local', 'sky', 'Montreal', '9°C']);
    expect(usage.pages['/']!.faces.mono).toBe('U+41-5A');
    expect(usage.faces.mono!.contexts[0]!.words).toEqual(['Local', 'sky']);
  });

  it('takes a glob or * for the pages, and a family to name the faces', () => {
    const r = withExtraText(usage, { '/blog/**': '€', '*': { 'geist mono': '°' } });
    expect(r.usage.pages['/blog/a/']!.faces.serif).toBe('U+41-5A, U+20AC');
    expect(r.usage.pages['/']!.faces).toEqual({ mono: 'U+41-5A, U+B0', serif: 'U+41-5A' });
  });

  it('says what matched nothing', () => {
    const r = withExtraText(usage, { '/menu/': 'é', '/': { Inter: 'é' } });
    expect(r.unmatched).toEqual(['/menu/', '/: Inter']);
    expect(r.usage.pages).toEqual(usage.pages);
  });

  it('is the same object when nothing is declared', () => {
    expect(withExtraText(usage, undefined).usage).toBe(usage);
    expect(withExtraText(usage, {}).usage).toBe(usage);
  });
});
