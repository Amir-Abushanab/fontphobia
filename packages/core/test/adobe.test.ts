// adobe-fonts (§6.6): report only. The kit files are measured in memory; here a local font stands in.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adobeFaceFacts, adobeFindings, fvdOf } from '../src/index.ts';

const inter = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../fixtures/fonts/InterVariable.ttf', import.meta.url))));
const KIT = 'https://use.typekit.net/abc1234.css';
const face = (words: string[]) => ({ family: '"inter"', descriptors: { 'font-weight': '400', 'font-style': 'normal' }, contexts: [{ features: '', words }] });

describe('adobe-fonts report', () => {
  it('names Font Variation Descriptions', () => {
    expect(fvdOf({ 'font-weight': '700', 'font-style': 'italic' })).toBe('i7');
    expect(fvdOf({})).toBe('n4');
  });

  it('finds words that need OpenType features beyond kerning, and the features', async () => {
    const plain = await adobeFaceFacts(face(['Hello', 'world']), inter, { kit: KIT, id: 'a' });
    expect(plain.needsFeatures).toEqual([]);
    expect(plain.extraFeatures).toContain('calt');
    const arrow = await adobeFaceFacts(face(['Hello', 'a->b']), inter, { kit: KIT, id: 'a' });
    expect(arrow.needsFeatures).toEqual(['a->b']);
    expect(arrow.usedFeatures).toContain('calt');
  });

  it('turns the measurements into kit settings', async () => {
    const facts = [await adobeFaceFacts(face(['Hello']), inter, { kit: KIT, id: 'inter-400' })];
    const u = {
      faces: { 'inter-400': { family: '"inter"', descriptors: { 'font-weight': '400', 'font-display': 'auto' }, sheet: KIT, chars: 'Helo', pages: ['/'], source: { adapter: 'adobe-fonts' } } },
      unloaded: { 'inter-700-italic': { family: '"inter"', descriptors: { 'font-weight': '700', 'font-style': 'italic' }, sheet: KIT } },
      pages: { '/': { fonts: [{ url: '/af/1/2/l?primer=x', status: 200, bytes: 40_960 }] } },
    };
    const f = adobeFindings(u, facts).map((x) => x.text);
    expect(f[0]).toMatch(/^kit abc1234: 1 face\(s\) used, up to 40\.0 KB of kit fonts per page/);
    expect(f[1]).toBe('kit abc1234: no page uses inter i7; remove this style from the project (unused styles never download, so this mainly shrinks the kit CSS)');
    expect(f[2]).toMatch(/^kit abc1234: none of the 1 crawled words shape differently with only kerning, so "Include OpenType features" can be turned off/);
    expect(f[3]).toMatch(/^kit abc1234: the pages use only Basic Latin and Latin-1 characters, but inter n4 maps \d+ characters/);
    expect(f[4]).toBe('kit abc1234: font-display is auto (kit setting; fontphobia never changes it)');
  });
});
