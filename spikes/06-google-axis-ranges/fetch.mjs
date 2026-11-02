// Fetches Google Fonts css2 for full and narrowed axis ranges, downloads the
// latin slice of each, and writes fonts/<key>.woff2 plus fonts/index.json.
// Run twice (`node fetch.mjs` then `node fetch.mjs --refetch`) to test that the
// same URL returns the same bytes.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
export const QUERIES = {
  'inter-full': 'Inter:opsz,wght@14..32,100..900',
  'inter-wght-100-900': 'Inter:wght@100..900',
  'inter-wght-400-700': 'Inter:wght@400..700',
  'inter-opsz-16-24-wght-100-900': 'Inter:opsz,wght@16..24,100..900',
  'inter-opsz-16-24-wght-400-700': 'Inter:opsz,wght@16..24,400..700',
  'inter-wght-400': 'Inter:wght@400',
  'flex-full': 'Roboto+Flex:opsz,wght@8..144,100..1000',
  'flex-wght-100-1000': 'Roboto+Flex:wght@100..1000',
  'flex-wght-400-700': 'Roboto+Flex:wght@400..700',
  'flex-opsz-12-32-wght-400-700': 'Roboto+Flex:opsz,wght@12..32,400..700',
};

const refetch = process.argv.includes('--refetch');
mkdirSync(new URL('./fonts/', import.meta.url), { recursive: true });
const indexUrl = new URL('./fonts/index.json', import.meta.url);
const prev = existsSync(indexUrl) ? JSON.parse(readFileSync(indexUrl, 'utf8')) : {};
const index = {};
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

for (const [key, q] of Object.entries(QUERIES)) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${q}&display=swap`, { headers: { 'user-agent': UA } })).text();
  const blocks = css.split('/*').slice(1).map((b) => ({
    subset: b.slice(0, b.indexOf('*/')).trim(),
    url: b.match(/url\(([^)]+)\)/)?.[1],
    unicodeRange: b.match(/unicode-range:\s*([^;]+);/)?.[1],
    weight: b.match(/font-weight:\s*([^;]+);/)?.[1],
  }));
  const latin = blocks.find((b) => b.subset === 'latin');
  const buf = Buffer.from(await (await fetch(latin.url, { headers: { 'user-agent': UA } })).arrayBuffer());
  if (!refetch) writeFileSync(new URL(`./fonts/${key}.woff2`, import.meta.url), buf);
  index[key] = {
    query: q,
    subsets: blocks.map((b) => b.subset),
    unicodeRanges: Object.fromEntries(blocks.map((b) => [b.subset, b.unicodeRange])),
    weight: latin.weight,
    url: latin.url,
    bytes: buf.length,
    sha: sha(buf),
  };
  if (refetch) {
    const p = prev[key];
    console.log(key.padEnd(32), 'url same:', p?.url === latin.url, 'bytes same:', p?.sha === index[key].sha);
  } else {
    console.log(key.padEnd(32), String(buf.length).padStart(7), 'B', index[key].sha, latin.weight);
  }
}
if (!refetch) writeFileSync(indexUrl, JSON.stringify(index, null, 2));
