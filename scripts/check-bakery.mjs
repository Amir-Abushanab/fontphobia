// No packages or browser needed: refuse to publish stale source/measurement pairs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, sourceFingerprint } from './bakery-files.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = join(repo, 'site/bakery');
const results = JSON.parse(readFileSync(join(output, 'measurements.json'), 'utf8'));
const fail = (message) => {
  throw new Error(`${message}. Rebuild with pnpm bakery:build.`);
};
if (sourceFingerprint(join(repo, 'examples/bakery')).sha256 !== results.source.sha256)
  fail('The bakery source changed after its measurements');
for (const [file, hash] of Object.entries(results.generatedFiles)) {
  if (sha256(readFileSync(join(output, file))) !== hash) fail(`The published ${file} changed after measurement`);
}
if (
  !results.verification.ok ||
  results.verification.publicComparisons.length !== 16 ||
  results.verification.publicComparisons.some(
    (c) => c.pixels !== 0 || c.channelTolerance !== 1 || !c.imageBodiesIdentical || !c.imageGeometryIdentical,
  )
)
  fail('The published comparisons did not all match');
if (
  results.verification.states.length !== 1 ||
  results.verification.states.some((c) => c.pixels !== 0 || c.channelTolerance !== 1)
)
  fail('The filtered menu comparison did not match');
if (results.pages.length !== 16) fail('The measurement matrix is incomplete');
for (const page of results.pages)
  for (const mode of ['before', 'after']) {
    const resources = page.resources[mode];
    const fonts = resources.filter((resource) => resource.type === 'font');
    if (
      resources.reduce((n, resource) => n + resource.bytes, 0) !== page[mode].totalBytes ||
      fonts.reduce((n, resource) => n + resource.bytes, 0) !== page[mode].fontBytes ||
      fonts.length !== page[mode].fontRequests ||
      resources.length !== page[mode].requests
    )
      fail(`Invalid resource totals on ${page.page}`);
  }
console.log('Bakery source, published files, and measured comparisons match.');
