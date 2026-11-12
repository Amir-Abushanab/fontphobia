// Usage: node scripts/set-version.mjs <version>
// Sets the version in packages/cli/package.json and every `fontphobia@<semver>` pin in README.md and docs/ci.md.
// Generated files (site/**) record the version that built them and are left alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const version = process.argv[2];
if (!version || !new RegExp(`^${SEMVER}$`).test(version)) { console.error('usage: node scripts/set-version.mjs <semver>'); process.exit(1); }

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const pkgPath = path('packages/cli/package.json');
const pkg = readFileSync(pkgPath, 'utf8');
if (!/^  "version": "/m.test(pkg)) { console.error('no version field in packages/cli/package.json'); process.exit(1); }
writeFileSync(pkgPath, pkg.replace(/^(  "version": ")[^"]*(",)$/m, `$1${version}$2`));
console.log(`packages/cli/package.json: ${version}`);

for (const f of ['README.md', 'docs/ci.md']) {
  let n = 0;
  const text = readFileSync(path(f), 'utf8').replace(new RegExp(`fontphobia@${SEMVER}`, 'g'), () => (n++, `fontphobia@${version}`));
  writeFileSync(path(f), text);
  console.log(`${f}: ${n} pin${n === 1 ? '' : 's'}`);
}
console.log(`Next: add a "## ${version}" section to CHANGELOG.md, commit, and push a v${version} tag.`);
