// Run by `pnpm run version`, after `changeset version`, so the Version Packages PR carries every
// place that states the version in packages/cli/package.json:
// - the `fontphobia@<semver>` pins in README.md and docs/ci.md;
// - `metadata.library_version` in the agent skill, packages/cli/skills/fontphobia/SKILL.md
//   (`intent stale` reports a skill that has fallen behind its package).
// Generated files (site/**) record the version that built them and are left alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
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
  if (!pins) {
    console.error(`${f}: no fontphobia@<version> pin found`);
    process.exit(1);
  }
  if (updated) writeFileSync(path(f), after);
  console.log(`${f}: ${pins} pin${pins === 1 ? '' : 's'} at ${version}${updated ? ` (${updated} updated)` : ''}`);
}

// Only the field inside the leading YAML frontmatter block. Single quotes, as the skill is written.
const SKILL = 'packages/cli/skills/fontphobia/SKILL.md';
const skill = readFileSync(path(SKILL), 'utf8');
const end = skill.indexOf('\n---', 4);
const field = /^(\s*library_version:\s*)['"]?[^'"\n]*['"]?$/m;
if (!skill.startsWith('---\n') || end === -1 || !field.test(skill.slice(0, end))) {
  console.error(`${SKILL}: no metadata.library_version in the frontmatter`);
  process.exit(1);
}
const next = skill.slice(0, end).replace(field, `$1'${version}'`) + skill.slice(end);
if (next !== skill) writeFileSync(path(SKILL), next);
console.log(`${SKILL}: library_version ${version}${next !== skill ? ' (updated)' : ''}`);
