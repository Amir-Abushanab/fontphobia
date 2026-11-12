// What the crawler hands to the usage builder for one page visit (one URL × viewport × font size).
// Environment-dependent data stops here; everything after this is a pure function (§4).
import type { CounterStyle, FontFaceRule, Keyframes } from '../css/stylesheet.ts';

/** Computed styles requested from DOMSnapshot, in this order (§7.3). */
export const STYLE_PROPS = [
  'font-family',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-size',
  'font-variation-settings',
  'font-feature-settings',
  'font-variant-ligatures',
  'font-variant-caps',
  'font-variant-numeric',
  'font-variant-east-asian',
  'font-variant-position',
  'font-variant-alternates',
  'font-kerning',
  'font-optical-sizing',
  'font-synthesis',
  'letter-spacing',
  'text-transform',
  'hyphens',
  'hyphenate-character',
  'text-overflow',
  '-webkit-line-clamp',
  'text-emphasis-style',
  '-webkit-text-security',
  'writing-mode',
  '-webkit-locale',
  'list-style-type',
  'content',
  'animation-name',
] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];
/** One computed style, as values in STYLE_PROPS order. */
export type StyleRow = string[];

export type RunKind =
  | 'text'
  | 'before'
  | 'after'
  | 'marker'
  | 'first-letter'
  | 'first-line'
  | 'value'
  | 'placeholder'
  | 'option'
  | 'textarea'
  | 'password'
  | 'full-width'
  | 'full-size-kana';

export interface Run {
  text: string;
  /** Index into Visit.styles. */
  style: number;
  kind: RunKind;
  /** Style of the nearest block ancestor with text-overflow: ellipsis or line-clamp. */
  ellipsis?: number;
  /** Inside <q>. */
  q?: true;
  /** Editable text: text inputs, textareas, contenteditable (§7.4 last row). */
  editable?: true;
  /** For form controls: the input type. */
  inputType?: string;
}

/** A rule whose font values apply to these runs in some state the crawl didn't render (§7.5). */
export interface DeclaredHit {
  runs: number[];
  decls: Record<string, string>;
  /** ":hover", "@media print", "@keyframes pulse", … */
  origin: string;
}

export interface CapturedFace extends FontFaceRule {
  /** Stylesheet URL, or "inline" for <style> and constructed sheets. */
  sheet: string;
  /** src URLs resolved against the stylesheet. */
  urls: string[];
}

export interface FontResponse {
  url: string;
  status: number;
  /** Decoded body size. */
  bytes: number;
  /** Bytes on the wire (headers excluded). */
  transfer: number;
  sha256?: string;
  mime?: string;
  /** The stylesheet or script that requested it. */
  initiator?: string;
}

export interface Preload {
  href: string;
  crossorigin: string | null;
  type?: string;
  media?: string;
}

export interface PlatformFontsHit {
  runs: number[];
  fonts: { family: string; postscript: string; custom: boolean; glyphs: number }[];
}

export interface Visit {
  /** Canonical page key: pathname + search of the final URL. */
  page: string;
  url: string;
  viewport: number;
  /** Default font size (Page.setFontSizes standard). */
  fontSize: number;
  textScale?: number;
  /** Behind a login: characters only, no words (§7.6). */
  private?: boolean;
  styles: StyleRow[];
  runs: Run[];
  declared: DeclaredHit[];
  faces: CapturedFace[];
  featureValues: [family: string, type: string, name: string, values: number[]][];
  counterStyles: CounterStyle[];
  keyframes: Keyframes[];
  fonts: FontResponse[];
  preloads: Preload[];
  platform: PlatformFontsHit[];
  /** Characters Intl produces for each locale: digits, separators, date parts (§7.3 step 5). */
  locales: Record<string, string>;
  /** Default `lang` of the document. */
  lang?: string;
  emMediaQueries?: boolean;
  textScaleMeta?: boolean;
  notes: string[];
}

/** Facts about a downloaded font file the builder needs (computed once per sha256). */
export interface FontFacts {
  sha256: string;
  cmap: Set<number>;
  /** GSUB ∪ GPOS feature tags. */
  features: Set<string>;
  axes: { tag: string; min: number; default: number; max: number }[];
}

export const styleOf = (row: StyleRow): Record<StyleProp, string> =>
  Object.fromEntries(STYLE_PROPS.map((p, i) => [p, row[i] ?? ''])) as Record<StyleProp, string>;
