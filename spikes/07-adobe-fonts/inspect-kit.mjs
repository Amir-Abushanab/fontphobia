// Usage: node inspect-kit.mjs <kitId> [...]
// Fetches https://use.typekit.net/<kit>.css, downloads each woff2 into memory
// (never to disk: Adobe Fonts files may not be stored or redistributed), and
// prints the primer (character set), cmap size, glyph count, GSUB/GPOS
// features, axes and @font-face descriptors.
// Needs fontkit and wawoff2: run from this dir after `pnpm install`.
import { decompress } from 'wawoff2';
import * as fontkit from 'fontkit';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
for (const kit of process.argv.slice(2)) {
  const css = await (await fetch(`https://use.typekit.net/${kit}.css`, { headers: { 'user-agent': UA } })).text();
  const faces = css.split('@font-face').slice(1);
  console.log(`== ${kit}: ${faces.length} faces; unicode-range: ${/unicode-range/.test(css)}; imports: ${(css.match(/@import url\("([^"]+)"/) || [])[1]?.split('?')[0]}`);
  const only = process.env.FAMILY;
  for (const face of (only ? faces.filter((x) => x.includes(`"${only}"`)) : faces).slice(0, 3)) {
    const family = face.match(/font-family:"([^"]+)"/)[1];
    const url = face.match(/url\("([^"]+)"\) format\("woff2"\)/)[1];
    const primer = new URL(url).searchParams.get('primer').slice(0, 8);
    const desc = face.match(/font-display:[^}]+/)[0].replace(/\s+/g, ' ').trim();
    const buf = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
    const f = fontkit.create(Buffer.from(await decompress(buf)));
    const feats = [...new Set([...(f.GSUB?.featureList ?? []), ...(f.GPOS?.featureList ?? [])].map((x) => x.tag))].sort();
    console.log(`  ${family} [${desc}] primer=${primer} woff2=${buf.length}B glyphs=${f.numGlyphs} cmap=${f.characterSet.length} axes=${Object.keys(f.variationAxes).join(',') || 'none'} hinting=${'fpgm' in f.directory.tables || 'prep' in f.directory.tables} features=${feats.join(' ')}`);
  }
}
