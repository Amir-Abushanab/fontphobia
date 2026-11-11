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
writeFileSync(new URL('demo-data.json', site), JSON.stringify({
  _comment: 'Generated from .fontphobia/manifest.json and the source fonts by scripts/site-demo-data.mjs.',
  faces,
}) + '\n');
