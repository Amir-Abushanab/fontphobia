// adobe-fonts (§6.6): report only. The kit files are measured in memory; here a local font stands in.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adobeFaceFacts, adobeFindings, fvdOf } from '../src/index.ts';

const inter = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../fixtures/fonts/InterVariable.ttf', import.meta.url))));
const KIT = 'https://use.typekit.net/abc1234.css';
/** usage.json stores `chars` as a unicode-range string. */
const ranges = (s: string) => [...new Set([...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase()))].join(', ');
const face = (words: string[]) => ({ family: '"inter"', descriptors: { 'font-weight': '400', 'font-style': 'normal' }, contexts: [{ features: '', words }] });

describe('adobe-fonts report', () => {
  it('names Font Variation Descriptions', () => {
    expect(fvdOf({ 'font-weight': '700', 'font-style': 'italic' })).toBe('i7');
    expect(fvdOf({})).toBe('n4');
    // A variable kit face: the weight is a range, Adobe's fvd is in the file URL.
    expect(fvdOf({ 'font-weight': '200 900', 'font-style': 'italic', src: 'url("https://use.typekit.net/af/50d9ea/000000000000000077454916/31/l?primer=7cdc&fvd=i4&v=3") format("woff2")' })).toBe('i4');
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
      faces: { 'inter-400': { family: '"inter"', descriptors: { 'font-weight': '400', 'font-display': 'auto' }, sheet: KIT, chars: ranges('Helo'), pages: ['/'], source: { adapter: 'adobe-fonts' } } },
      unloaded: { 'inter-700-italic': { family: '"inter"', descriptors: { 'font-weight': '700', 'font-style': 'italic' }, sheet: KIT } },
      pages: { '/': { fonts: [{ url: '/af/1/2/l?primer=x', status: 200, bytes: 40_960 }] } },
    };
    const f = adobeFindings(u, facts).map((x) => x.text);
    expect(f[0]).toMatch(/^kit abc1234: 1 face\(s\) used, up to 40\.0 KB of kit fonts per page/);
    expect(f[1]).toBe('kit abc1234: no page uses inter i7; `fontphobia apply-kit` removes those no weight in the code would match, through Adobe\'s API (keeping, say, a bold style that <strong> would use). Unused styles never download, so this mainly shrinks the kit CSS');
    expect(f[2]).toMatch(/^kit abc1234: none of the 1 crawled words shape differently with only kerning, so "Include OpenType features" can be turned off/);
    expect(f[3]).toMatch(/^kit abc1234: every character the pages use is in Adobe's Default set \(EN, FR, DE, IT, PT, ES\), but inter n4 maps \d+ characters/);
    expect(f[4]).toBe('kit abc1234: font-display is auto (kit setting; fontphobia never changes it)');
    // Curly quotes, dashes and € are in Default; the low single quote isn't.
    const withChars = (chars: string) => adobeFindings({ ...u, faces: { 'inter-400': { ...u.faces['inter-400'], chars: ranges(chars) } } }, facts).map((x) => x.text)[3];
    expect(withChars('It’s “quoted” — €5')).toMatch(/is in Adobe's Default set/);
    expect(withChars('‚low‘')).toBe('kit abc1234: the pages use characters outside Adobe\'s Default set (‚); keep a character set that includes them');
  });
});
