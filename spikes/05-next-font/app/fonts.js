import { Inter, Roboto_Flex } from 'next/font/google';
import localFont from 'next/font/local';

// Q1: google, variable font, weight omitted (=> 'variable'), one subset preloaded.
export const interGoogle = Inter({ subsets: ['latin'] });

// Q1: google, same font with the opsz axis requested.
export const interGoogleOpsz = Inter({ subsets: ['latin'], axes: ['opsz'] });

// Q1: google, static weights array on a variable family.
export const interGoogleStatic = Inter({ subsets: ['latin'], weight: ['400', '700'] });

// Q1: google, Roboto Flex with extra axes.
export const robotoFlex = Roboto_Flex({ subsets: ['latin'], axes: ['wdth', 'opsz'] });

// Q2: local, two files in one call. `declarations` applies to both.
export const interLocal = localFont({
  src: [
    { path: '../fonts/inter-latin-opsz-normal.woff2', weight: '100 900', style: 'normal' },
    { path: '../fonts/inter-latin-ext-opsz-normal.woff2', weight: '100 900', style: 'normal' },
  ],
  declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF' }],
});

// Q2: local, the split pattern fontphobia wants: two calls sharing one family
// name via declarations font-family, each with its own unicode-range.
export const splitCore = localFont({
  src: '../fonts/inter-latin-opsz-normal.woff2',
  weight: '100 900',
  declarations: [
    { prop: 'font-family', value: "'Inter Split'" },
    { prop: 'unicode-range', value: 'U+0000-00FF, U+2000-206F' },
  ],
});
export const splitExt = localFont({
  src: '../fonts/inter-latin-ext-opsz-normal.woff2',
  weight: '100 900',
  preload: false,
  declarations: [
    { prop: 'font-family', value: "'Inter Split'" },
    { prop: 'unicode-range', value: 'U+0100-024F, U+1E00-1EFF' },
  ],
});

// Q2: per-entry unicode-range attempt. The types don't allow extra keys on src
// entries; at runtime the loader only reads path/weight/style, so these are
// silently dropped.
export const perEntry = localFont({
  src: [
    { path: '../fonts/inter-latin-opsz-normal.woff2', weight: '100 900', unicodeRange: 'U+0000-00FF', declarations: [{ prop: 'unicode-range', value: 'U+0000-00FF' }] },
    { path: '../fonts/inter-latin-ext-opsz-normal.woff2', weight: '100 900', unicodeRange: 'U+0100-024F', declarations: [{ prop: 'unicode-range', value: 'U+0100-024F' }] },
  ],
});

// Q2/Q3: the split with the extended call's fallback face suppressed, plus a
// CSS variable, to see what `variable` and `className` reference.
export const splitCoreVar = localFont({
  src: '../fonts/inter-latin-opsz-normal.woff2',
  weight: '100 900',
  variable: '--font-split',
  declarations: [
    { prop: 'font-family', value: "'Inter Split2'" },
    { prop: 'unicode-range', value: 'U+0000-00FF' },
  ],
});
export const splitExtNoFallback = localFont({
  src: '../fonts/inter-latin-ext-opsz-normal.woff2',
  weight: '100 900',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Inter Split2'" },
    { prop: 'unicode-range', value: 'U+0100-024F' },
  ],
});
