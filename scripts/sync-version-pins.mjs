// Run by `pnpm run version`, after `changeset version`: sets every `fontphobia@<semver>` pin in
// README.md and docs/ci.md to the version in packages/cli/package.json, so the Version Packages PR
// carries them. Generated files (site/**) record the version that built them and are left alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const { version } = JSON.parse(readFileSync(path('packages/cli/package.json'), 'utf8'));

for (const f of ['README.md', 'docs/ci.md']) {
  let pins = 0;
  let updated = 0;
  const before = readFileSync(path(f), 'utf8');
  const after = before.replace(new RegExp(`fontphobia@${SEMVER}`, 'g'), (pin) => {
    pins++;
    if (pin !== `fontphobia@${version}`) updated++;
    return `fontphobia@${version}`;
  });
  if (!pins) { console.error(`${f}: no fontphobia@<version> pin found`); process.exit(1); }
  if (updated) writeFileSync(path(f), after);
  console.log(`${f}: ${pins} pin${pins === 1 ? '' : 's'} at ${version}${updated ? ` (${updated} updated)` : ''}`);
}
