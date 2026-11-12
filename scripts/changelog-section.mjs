// Usage: node scripts/changelog-section.mjs <version>
// Prints the body of the `## <version>` section of CHANGELOG.md. Exits 1 when the section is missing or empty.
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) { console.error('usage: node scripts/changelog-section.mjs <version>'); process.exit(1); }
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) { console.error(`CHANGELOG.md has no "## ${version}" section`); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) { console.error(`The "## ${version}" section of CHANGELOG.md is empty`); process.exit(1); }
console.log(body);
