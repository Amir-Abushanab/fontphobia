import { describe, expect, it } from 'vitest';
import { htmlText, scriptStrings } from '../src/check/check.ts';

describe('htmlText', () => {
  it('decodes the full set of named references', () => {
    const t = htmlText('<p>&rarr; &times; &euro; &eacute; &bull; &deg; &amp; &lt;</p>');
    for (const ch of '→×€é•°&<') expect(t).toContain(ch);
    expect(t).not.toMatch(/&[a-z]+;/);
  });
  it('decodes numeric references, in attributes too', () => {
    const t = htmlText('<p>&#233;&#x20AC;</p><img alt="&rarr; &#x2603;">');
    expect(t).toContain('é€');
    expect(t).toContain('→ ☃');
  });
  it('never throws on out-of-range or surrogate code points', () => {
    expect(htmlText('<p>&#99999999; &#x110000; &#xD800;</p>')).toContain('\uFFFD');
    expect(htmlText('<style>a::after{content:"\\110000"}</style>')).toContain('\uFFFD');
    expect(htmlText('<style>a::after{content:"\\D800"}</style>')).toContain('\uFFFD');
    expect(scriptStrings('"é\\u{110000}"')).toContain('\uFFFD');
  });
  it('reads single-quoted attributes like double-quoted ones', () => {
    const t = htmlText(
      "<img alt='Ω &rarr;'><p style='--x: 1' title='★'>x</p><style>a::after{content:'\\2603'}</style>",
    );
    for (const ch of 'Ω→★☃') expect(t).toContain(ch);
  });
  it('leaves unknown references as they are', () =>
    expect(htmlText('<p>&nosuchthing;</p>')).toContain('&nosuchthing;'));
  it('does not count <title> text, but keeps the title attribute', () => {
    const t = htmlText('<html><head><title>Zürich ★</title></head><body><p title="Ω">x</p></body></html>');
    expect(t).not.toContain('★');
    expect(t).not.toContain('Zürich');
    expect(t).toContain('Ω');
  });
});
