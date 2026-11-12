// Golden hashes: the same inputs must give byte-identical output on every OS, arch and Node
// version (PLAN §4, M1). CI runs this on macOS, Linux and Windows × Node 22/24.
// Regenerate deliberately with `pnpm golden:update` (only when an intended change lands).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { subsetFont, toSfnt, type SubsetOptions } from '../src/index.ts';
import { ASCII, LATIN1, fixture, sha256 } from './helpers.ts';

const file = new URL('./__golden__/hashes.json', import.meta.url);
const cases: Record<string, [Parameters<typeof fixture>[0], SubsetOptions]> = {
  'inter latin1': ['InterVariable.ttf', { unicodes: LATIN1 }],
  'inter ascii +tnum,ss01': ['InterVariable.ttf', { unicodes: ASCII, features: { add: ['tnum', 'ss01'] } }],
  'inter all features': ['InterVariable.ttf', { unicodes: LATIN1, features: '*' }],
  'inter wght 400..700 opsz 14..24': [
    'InterVariable.ttf',
    { unicodes: LATIN1, axes: { wght: { min: 400, max: 700 }, opsz: { min: 14, max: 24 } } },
  ],
  'inter pinned 550/20': ['InterVariable.ttf', { unicodes: LATIN1, axes: { wght: 550, opsz: 20 } }],
  'inter everything': ['InterVariable.ttf', { unicodes: '*' }],
  'dejavu latin1': ['DejaVuSans.ttf', { unicodes: LATIN1 }],
  'dejavu latin1 no hinting': ['DejaVuSans.ttf', { unicodes: LATIN1, hinting: false }],
  'inter hinted (woff2 source) ascii': ['Inter-Regular-hinted.woff2', { unicodes: ASCII }],
};

test('outputs match the committed golden hashes', async () => {
  const got: Record<string, string> = {};
  for (const [name, [font, opts]] of Object.entries(cases)) {
    const r = await subsetFont(fixture(font), opts);
    got[name] = `${sha256(r.woff2)} ${r.woff2.byteLength}`;
  }
  got['decoded hinted fixture'] = sha256(await toSfnt(fixture('Inter-Regular-hinted.woff2')));
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
    if (!process.env.UPDATE_GOLDEN)
      throw new Error('No golden file existed; wrote one. Review and commit it, then rerun.');
    return;
  }
  expect(got).toEqual(JSON.parse(readFileSync(file, 'utf8')));
});
