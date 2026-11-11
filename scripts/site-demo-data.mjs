// Run after rebuilding site/'s fonts: node scripts/site-demo-data.mjs
// Keep the playground tied to the files we ship, including the source font's actual cmap.
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectFont, parseUnicodeRange } from '../packages/core/src/index.ts';

const site = new URL('../site/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.fontphobia/manifest.json', site), 'utf8'));
const faces = [];
for (const entry of Object.values(manifest.entries)) {
  const source = await inspectFont(new Uint8Array(readFileSync(new URL(entry.source.file, site))));
  faces.push({
    family: entry.family,
    source: { url: entry.source.file, bytes: source.file.bytes, ranges: parseUnicodeRange(source.unicodes.ranges) },
    outputs: entry.outputs.map(({ role, bytes, url, unicodeRange }) => ({ role, bytes, url, ranges: parseUnicodeRange(unicodeRange) })),
  });
}
const data = {
  _comment: 'Generated from .fontphobia/manifest.json and the source fonts by scripts/site-demo-data.mjs.',
  faces,
};
writeFileSync(new URL('demo-data.json', site), JSON.stringify(data) + '\n');
// Embed the same metadata so the playground also works when index.html is opened
// directly from disk. Escaping < keeps future font names safe inside a script block.
const index = new URL('index.html', site);
const embedded = `<script id="font-data" type="application/json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`;
let html = readFileSync(index, 'utf8');
if (html.includes('<script id="font-data"')) {
  html = html.replace(/<script id="font-data" type="application\/json">[\s\S]*?<\/script>/, () => embedded);
} else {
  html = html.replace(/<script\b[^>]*\bsrc="demo\.js(?:\?[^\"]*)?"[^>]*><\/script>/, (script) => `${embedded}\n${script}`);
}
writeFileSync(index, html);
