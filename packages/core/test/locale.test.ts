import { describe, expect, it } from 'vitest';
import { cldrLocale, localeChars } from '../src/plan/locale.ts';
import { quoteChars } from '../src/usage/rules.ts';

describe('cldrLocale', () => {
  it.each([
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant-HK'],
    ['sr-ME', 'sr-Latn-ME'],
    ['pa-PK', 'pa-Arab'],
    ['pt-BR', 'pt'],
    ['en-AU', 'en-AU'],
    ['fr', 'fr'],
    ['zh', 'zh'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-CN', 'zh'],
  ])('%s → %s', (tag, want) => expect(cldrLocale(tag)).toBe(want));
  it('gives Traditional characters for zh-TW', () => expect(localeChars('zh-TW')).toContain(0x5011));
  it('quotes follow the same fallback', () => {
    expect(quoteChars('zh-TW')).toBe(quoteChars('zh-Hant'));
    expect(quoteChars('sr-ME')).toBe(quoteChars('sr-Latn-ME'));
    expect(quoteChars('pt_BR')).toBe(quoteChars('pt'));
  });
});
