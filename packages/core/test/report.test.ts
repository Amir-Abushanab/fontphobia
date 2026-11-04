// Audit findings that need no browser: duplicate sources, with the @nuxt/fonts fix (§6.8).
import { describe, expect, it } from 'vitest';
import { auditFindings } from '../src/index.ts';

const crawl = { framework: { name: 'Nuxt', tier: 1 as const }, mode: 'static', source: '.output/public', pages: ['/'], failed: {}, dynamicRoutes: [], visits: 1, viewports: [1280], fontSizes: [16], durationMs: 1 };
const face = (family: string, adapter: string) => ({ family, descriptors: {}, source: { adapter }, files: [], chars: 'a', count: 1, inserted: {}, pages: ['/'], features: [], rendered: {} });

describe('duplicate sources', () => {
  it('names the @nuxt/fonts setting that stops the second copy', () => {
    const u = {
      meta: { fontphobia: '1', chrome: '1', framework: 'nuxt', mode: 'static', viewports: [1280], fontSizes: [16] },
      faces: { a: face("'Inter Variable'", 'fontsource') },
      pages: {},
      unloaded: { b: { family: 'Inter Variable', descriptors: {}, sheet: 'inline', urls: ['/_nuxt/fonts/Inter_Variable-abc.woff2'] } },
    };
    const d = auditFindings(u as never, crawl as never).filter((f) => f.kind === 'duplicate');
    expect(d.map((f) => f.text)).toEqual([`Inter Variable loads from more than one source: fontsource, nuxt-fonts. @nuxt/fonts doesn't see head <link>s or package imports and resolves Inter Variable again: add { name: 'Inter Variable', provider: 'none' } to fonts.families in nuxt.config so only the other source loads it (that changes which file pages load; run fontphobia verify after)`]);
  });
});
