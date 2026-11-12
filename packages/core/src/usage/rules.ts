// §7.4: characters the browser draws that aren't in the layout text.
// Each function returns the characters a trigger adds; the builder attributes them through the
// same family stack as the text, so a rule only reaches the faces its trigger applies to.
import type { CounterStyle } from '../css/stylesheet.ts';
import { cldrFallback } from '../plan/locale.ts';
import { splitTop, unquote } from '../css/values.ts';
import delimiters from '../data/cldr-delimiters.json' with { type: 'json' };

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join('');

/** `hyphens: auto` (and soft hyphens): U+2010, U+002D (Chrome uses either, depending on the font), plus hyphenate-character. */
export function hyphenChars(hyphens: string, hyphenateCharacter: string, text: string): string {
  const h = hyphens.trim();
  if (h === 'auto' || (h !== 'none' && text.includes('­'))) {
    const hc = hyphenateCharacter.trim();
    return '‐-' + (hc && hc !== 'auto' ? unquote(hc) : '');
  }
  return '';
}

/** `text-overflow: ellipsis | "<string>"`, `-webkit-line-clamp`. */
export function ellipsisChars(textOverflow: string, lineClamp: string): string {
  const parts = splitTop(textOverflow.trim(), ' ');
  let out = '';
  for (const p of parts) {
    if (p === 'ellipsis') out += '….';
    else if (/^["']/.test(p)) out += unquote(p);
  }
  if (lineClamp.trim() && lineClamp.trim() !== 'none') out += '….';
  return out;
}

/** Masking characters: password fields and -webkit-text-security (they differ by engine). */
export function maskChars(kind: string, textSecurity: string): string {
  const s = textSecurity.trim();
  if (kind === 'password') return '•●';
  if (s === 'disc') return '•●';
  if (s === 'circle') return '◦';
  if (s === 'square') return '■';
  return '';
}

/** Small caps the browser synthesizes from capitals when the face lacks the feature. */
export function synthesizedCapsChars(caps: string, faceFeatures: Set<string>, text: string, locale: string): string {
  const c = caps.trim();
  if (c === 'normal' || !c) return '';
  const needs = c === 'all-small-caps' || c === 'all-petite-caps' ? ['c2sc', 'smcp'] : c === 'unicase' ? ['unic'] : c === 'titling-caps' ? [] : ['smcp'];
  if (!needs.length || needs.every((t) => faceFeatures.has(t)) || (c.includes('petite') && faceFeatures.has(c === 'all-petite-caps' ? 'c2pc' : 'pcap'))) return '';
  let up: string;
  try { up = text.toLocaleUpperCase(locale || undefined); } catch { up = text.toUpperCase(); }
  return [...new Set(up)].filter((ch) => !text.includes(ch)).join('');
}

const SMALL_KANA: Record<string, string> = {
  'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'っ': 'つ', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ', 'ゕ': 'か', 'ゖ': 'け',
  'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ', 'ヵ': 'カ', 'ヶ': 'ケ',
  'ㇰ': 'ク', 'ㇱ': 'シ', 'ㇲ': 'ス', 'ㇳ': 'ト', 'ㇴ': 'ヌ', 'ㇵ': 'ハ', 'ㇶ': 'ヒ', 'ㇷ': 'フ', 'ㇸ': 'ヘ', 'ㇹ': 'ホ', 'ㇺ': 'ム', 'ㇻ': 'ラ', 'ㇼ': 'リ', 'ㇽ': 'ル', 'ㇾ': 'レ', 'ㇿ': 'ロ',
  'ｧ': 'ｱ', 'ｨ': 'ｲ', 'ｩ': 'ｳ', 'ｪ': 'ｴ', 'ｫ': 'ｵ', 'ｯ': 'ﾂ', 'ｬ': 'ﾔ', 'ｭ': 'ﾕ', 'ｮ': 'ﾖ',
};

/** `text-transform: full-width` (Firefox and Safari apply it; Chrome computes `none`). */
export function fullWidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += c === 0x20 ? '　' : c >= 0x21 && c <= 0x7e ? String.fromCodePoint(c + 0xfee0) : ch;
  }
  return out;
}
export const fullSizeKana = (text: string): string => [...text].map((ch) => SMALL_KANA[ch] ?? ch).join('');

const EMPHASIS: Record<string, [string, string]> = {
  dot: ['•', '◦'], circle: ['●', '○'], 'double-circle': ['◉', '◎'], triangle: ['▲', '△'], sesame: ['﹅', '﹆'],
};
/** `text-emphasis-style`: computed as "none", "filled circle", "open sesame", or a string. */
export function emphasisChars(v: string, writingMode: string): string {
  const s = v.trim();
  if (!s || s === 'none') return '';
  if (/^["']/.test(s)) return unquote(s);
  const w = s.split(/\s+/);
  const open = w.includes('open');
  const shape = w.find((x) => EMPHASIS[x]) ?? (writingMode.startsWith('vertical') ? 'sesame' : 'circle');
  return EMPHASIS[shape]![open ? 1 : 0];
}

/** Every character a counter style can produce (§7.4 "List markers, counter()"). */
const COUNTERS: Record<string, { chars: string; suffix?: string }> = {
  decimal: { chars: '0123456789-' }, 'decimal-leading-zero': { chars: '0123456789-' },
  'lower-roman': { chars: 'ivxlcdm-' }, 'upper-roman': { chars: 'IVXLCDM-' },
  'lower-alpha': { chars: range(0x61, 0x7a) }, 'lower-latin': { chars: range(0x61, 0x7a) },
  'upper-alpha': { chars: range(0x41, 0x5a) }, 'upper-latin': { chars: range(0x41, 0x5a) },
  'lower-greek': { chars: 'αβγδεζηθικλμνξοπρστυφχψω' },
  'lower-armenian': { chars: range(0x561, 0x586) }, 'upper-armenian': { chars: range(0x531, 0x556) }, armenian: { chars: range(0x531, 0x556) },
  georgian: { chars: range(0x10d0, 0x10f6) },
  hebrew: { chars: range(0x5d0, 0x5ea) + '׳״' },
  'arabic-indic': { chars: range(0x660, 0x669) }, persian: { chars: range(0x6f0, 0x6f9) },
  devanagari: { chars: range(0x966, 0x96f) }, bengali: { chars: range(0x9e6, 0x9ef) }, gujarati: { chars: range(0xae6, 0xaef) },
  gurmukhi: { chars: range(0xa66, 0xa6f) }, kannada: { chars: range(0xce6, 0xcef) }, malayalam: { chars: range(0xd66, 0xd6f) },
  oriya: { chars: range(0xb66, 0xb6f) }, tamil: { chars: range(0xbe6, 0xbef) }, telugu: { chars: range(0xc66, 0xc6f) },
  thai: { chars: range(0xe50, 0xe59) }, lao: { chars: range(0xed0, 0xed9) }, khmer: { chars: range(0x17e0, 0x17e9) },
  myanmar: { chars: range(0x1040, 0x1049) }, mongolian: { chars: range(0x1810, 0x1819) }, tibetan: { chars: range(0xf20, 0xf29) },
  'cjk-decimal': { chars: '〇一二三四五六七八九', suffix: '、' },
  'cjk-earthly-branch': { chars: '子丑寅卯辰巳午未申酉戌亥', suffix: '、' }, 'cjk-heavenly-stem': { chars: '甲乙丙丁戊己庚辛壬癸', suffix: '、' },
  'japanese-informal': { chars: '〇一二三四五六七八九十百千万億兆', suffix: '、' }, 'japanese-formal': { chars: '零壱弐参四伍六七八九拾百阡萬億兆', suffix: '、' },
  hiragana: { chars: range(0x3041, 0x3093), suffix: '、' }, katakana: { chars: range(0x30a1, 0x30f3), suffix: '、' },
  disc: { chars: '•', suffix: ' ' }, circle: { chars: '◦', suffix: ' ' }, square: { chars: '▪', suffix: ' ' },
  'disclosure-open': { chars: '▾', suffix: ' ' }, 'disclosure-closed': { chars: '▸◂', suffix: ' ' },
};

export function counterChars(type: string, custom: CounterStyle[] = [], seen = new Set<string>()): string {
  const t = type.trim();
  if (!t || t === 'none') return '';
  if (/^["']/.test(t)) return unquote(t);
  if (seen.has(t)) return '';
  seen.add(t);
  const c = custom.find((x) => x.name === t);
  if (c) {
    const base = c.extends ? counterChars(c.extends, custom, seen) : '';
    return base + c.symbols.join('') + c.additive.join('') + (c.prefix ?? '') + (c.suffix ?? '. ') + (c.pad ?? '') + (c.negative ?? '-') + counterChars(c.fallback ?? 'decimal', custom, seen);
  }
  const b = COUNTERS[t] ?? COUNTERS.decimal!;
  return b.chars + (b.suffix ?? '. ');
}

/** Counter styles named in a computed `content` value: counter(c, upper-roman), counters(c, ".", lower-alpha). */
export function contentCounterStyles(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/counters?\(([^)]*)\)/g)) {
    const args = splitTop(m[1]!);
    const isCounters = m[0].startsWith('counters');
    const style = args[isCounters ? 2 : 1];
    out.push(style ? style.trim() : 'decimal');
    if (isCounters && args[1]) out.push(args[1]);
  }
  return out;
}

const QUOTES = (delimiters as { quotes: Record<string, string> }).quotes;
/** CLDR quotation marks for a locale, falling back from "pt-BR" to "pt" and by script ("zh-TW" → "zh-Hant", §7.4 `<q>`). */
export function quoteChars(locale: string): string {
  const k = cldrFallback(locale.replace(/_/g, '-'), (id) => id in QUOTES);
  return (k && QUOTES[k]) || QUOTES.en || '“”‘’';
}

/** Input types that render locale digits and separators (§7.4). */
export const LOCALE_INPUT_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'number']);

/** Input types whose text renders in the control's font. */
export const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
