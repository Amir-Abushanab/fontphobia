// Reads axes, cmap size and file size of next/font/google's downloaded files,
// using the fontkit build that Next itself bundles.
const fs = require('fs');
const path = require('path');
const fontkit = require('next/dist/compiled/@next/font/dist/fontkit').default;
const media = path.join(__dirname, '../.next/static/media');
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(path.join(media, f));
  const font = fontkit.create ? fontkit.create(buf) : (fontkit.default || fontkit)(buf);
  console.log(f, {
    bytes: buf.length,
    axes: Object.fromEntries(Object.entries(font.variationAxes).map(([k, v]) => [k, `${v.min}..${v.max} (default ${v.default})`])),
    glyphs: font.numGlyphs,
    codepoints: font.characterSet.length,
    hhea: { ascent: font.ascent, descent: font.descent, lineGap: font.lineGap, upm: font.unitsPerEm },
  });
}
