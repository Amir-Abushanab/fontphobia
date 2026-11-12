// Emits dist/THIRD-PARTY-NOTICES.txt from the modules that end up in the bundle, plus data and WASM that are embedded without being imported.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LICENSE_FILE = /^(licen[sc]e|copying|notice)/i;
// Data generated from CLDR (packages/core/scripts/cldr.mjs) and the WASM copied next to the bundle.
const EXTRA = ['cldr-core', 'cldr-misc-full', 'harfbuzzjs'];
// Libraries compiled into the WASM whose npm wrappers ship only their own license: the upstream texts are kept in upstream-licenses/.
const UPSTREAM = [
  { name: 'HarfBuzz', where: 'compiled into harfbuzz.wasm and harfbuzz-subset.wasm (from harfbuzzjs)', license: 'MIT-Modern-Variant ("Old MIT")', url: 'https://github.com/harfbuzz/harfbuzz', file: 'harfbuzz-COPYING.txt' },
  { name: 'Brotli', where: 'compiled into the WOFF2 codec (from wawoff2)', license: 'MIT', url: 'https://github.com/google/brotli', file: 'brotli-LICENSE.txt' },
];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Nearest package.json with a name, walking up from a file under node_modules.
function packageRootOf(file) {
  for (let dir = dirname(file); dir.includes('node_modules'); dir = dirname(dir)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj) && readJson(pj).name) return dir;
  }
  return null;
}

function describe(root) {
  const pkg = readJson(join(root, 'package.json'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ? pkg.licenses.map((l) => l.type).join(' OR ') : undefined);
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const files = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && LICENSE_FILE.test(e.name)).map((e) => e.name).sort();
  return { name: pkg.name, version: pkg.version, license, url: (repo ?? pkg.homepage ?? '').replace(/^git\+/, ''), files: files.map((f) => ({ name: f, text: readFileSync(join(root, f), 'utf8').trim() })) };
}

export function thirdPartyNotices() {
  return {
    name: 'third-party-notices',
    generateBundle(_options, bundle) {
      const roots = new Set();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
          const file = id.replace(/^\0/, '').split('?')[0];
          if (!file.includes('node_modules')) continue;
          const root = packageRootOf(file);
          if (root) roots.add(root);
        }
      }
      // Packages embedded without being imported are resolved from packages/core, which depends on them.
      for (const name of EXTRA) roots.add(realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../../core/node_modules', name)));
      const pkgs = new Map();
      for (const root of roots) {
        const p = describe(root);
        if (p.name === 'playwright-core') continue;
        if (!p.files.length && !p.license) this.error(`third-party-notices: bundled package ${p.name}@${p.version} (${root}) has no license file and no license field`);
        pkgs.set(`${p.name}@${p.version}`, p);
      }
      const list = [...pkgs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
      const rule = '='.repeat(78);
      let out = 'THIRD-PARTY NOTICES\n\nfontphobia bundles the packages below and data generated from the Unicode CLDR.\nThe text of each license follows its entry.\n';
      for (const p of list) {
        out += `\n${rule}\n${p.name}@${p.version}\nLicense: ${p.license ?? 'not declared'}\n${p.url ? `URL: ${p.url}\n` : ''}${rule}\n`;
        if (!p.files.length) out += `\nThe package declares the license above and ships no license file.\n`;
        for (const f of p.files) out += `\n--- ${f.name} ---\n\n${f.text}\n`;
      }
      for (const u of UPSTREAM) {
        const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'upstream-licenses', u.file), 'utf8').trim();
        out += `\n${rule}\n${u.name}: ${u.where}\nLicense: ${u.license}\nURL: ${u.url}\n${rule}\n\n${text}\n`;
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: out });
    },
  };
}
