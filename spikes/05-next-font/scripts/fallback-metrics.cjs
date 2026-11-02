// Feeds original, subset and instanced versions of a font file through
// next/font/local's own fallback-metrics code (and Next's bundled fontkit).
const fs = require('fs');
const path = require('path');
const fontkit = require('next/dist/compiled/@next/font/dist/fontkit').default;
const { getFallbackMetricsFromFontFile } = require('next/dist/compiled/@next/font/dist/local/get-fallback-metrics-from-font-file');
const subsetFont = require('subset-font');

const src = fs.readFileSync(path.join(__dirname, '../fonts/inter-latin-opsz-normal.woff2'));
const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const latin1 = ascii + Array.from({ length: 96 }, (_, i) => String.fromCharCode(0xa0 + i)).join('');

const variants = {
  original: async () => src,
  'subset Latin-1, no instancing': () => subsetFont(src, latin1, { targetFormat: 'woff2' }),
  'subset ASCII, no instancing': () => subsetFont(src, ascii, { targetFormat: 'woff2' }),
  'subset ASCII minus "q"': () => subsetFont(src, ascii.replace('q', ''), { targetFormat: 'woff2' }),
  'wght 300..700 (default 400 kept)': () => subsetFont(src, latin1, { targetFormat: 'woff2', variationAxes: { wght: { min: 300, max: 700 } } }),
  'wght 500..700 (default clamps to 500)': () => subsetFont(src, latin1, { targetFormat: 'woff2', variationAxes: { wght: { min: 500, max: 700 } } }),
  'opsz pinned 14 (= default)': () => subsetFont(src, latin1, { targetFormat: 'woff2', variationAxes: { opsz: 14 } }),
  'opsz 16..32 (default clamps to 16)': () => subsetFont(src, latin1, { targetFormat: 'woff2', variationAxes: { opsz: { min: 16, max: 32 } } }),
  'opsz pinned 32': () => subsetFont(src, latin1, { targetFormat: 'woff2', variationAxes: { opsz: 32 } }),
};

(async () => {
  for (const [name, make] of Object.entries(variants)) {
    const buf = await make();
    const font = fontkit.create ? fontkit.create(buf) : fontkit(buf);
    const m = getFallbackMetricsFromFontFile(font, 'sans-serif');
    console.log(name.padEnd(40), String(buf.length).padStart(6), 'B',
      `size-adjust ${m.sizeAdjust}  ascent ${m.ascentOverride}  descent ${m.descentOverride}  lineGap ${m.lineGapOverride}`,
      ` hhea ${font.ascent}/${font.descent}/${font.lineGap}`);
  }
})();
