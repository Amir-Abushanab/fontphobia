// §11: where a font's license may come from, OFL Reserved Font Names, and the internal rename.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deriveName,
  detectLicense,
  licenseRefusal,
  nameStrings,
  planFace,
  readSfnt,
  toSfnt,
  withTables,
  type License,
  type PlanConfig,
  type UsageFaceJson,
  type UsageFileJson,
} from '../src/index.ts';
import { fixture } from './helpers.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const OFL = readFileSync(join(repo, 'fixtures/fonts/Inter-LICENSE.txt'), 'utf8');
const APACHE = 'Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n';

/** The font with name IDs 13 and 14 moved away: its name table says nothing about the license, like a commercial font's. */
function unlicensed(sfnt: Uint8Array): Uint8Array {
  const name = readSfnt(sfnt).tables.get('name')!.slice();
  const d = new DataView(name.buffer, name.byteOffset, name.byteLength);
  for (let i = 0; i < d.getUint16(2); i++) {
    const o = 6 + i * 12;
    const id = d.getUint16(o + 6);
    if (id === 13 || id === 14) d.setUint16(o + 6, 300 + id);
  }
  return withTables(sfnt, { name });
}
const inter = unlicensed(await toSfnt(fixture('InterVariable.ttf'))); // family "Inter Variable"
const dejavu = unlicensed(await toSfnt(fixture('DejaVuSans.ttf'))); // family "DejaVu Sans"

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-lic-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A temp project from { path: contents }; returns its root. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmp, 'p-'));
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), s);
  }
  return root;
}
const detect = (sfnt: Uint8Array, root: string, font: string) => detectLicense(sfnt, join(root, font), root);

describe('license files (§11)', () => {
  it("doesn't take the project's own package.json or root LICENSE as the font's", () => {
    expect(detectLicense(inter)).toMatchObject({ id: 'unknown', open: false, from: 'none' });
    const mit = tree({
      'package.json': JSON.stringify({ name: 'site', license: 'MIT' }),
      'public/fonts/Brand.ttf': '',
    });
    const a = detect(inter, mit, 'public/fonts/Brand.ttf');
    expect(a).toMatchObject({ id: 'unknown', open: false });
    expect(licenseRefusal(inter, a, false)).toMatch(/licenses\.allow/);
    const apache = tree({ LICENSE: APACHE, 'src/assets/fonts/Brand.ttf': '' });
    const b = detect(inter, apache, 'src/assets/fonts/Brand.ttf');
    expect(b).toMatchObject({ id: 'unknown', open: false });
    expect(licenseRefusal(inter, b, false)).toMatch(/licenses\.allow/);
    // A workspace package's root is a project root too.
    const mono = tree({
      'package.json': '{}',
      'apps/web/package.json': JSON.stringify({ license: 'MIT' }),
      'apps/web/LICENSE': APACHE,
      'apps/web/public/fonts/Brand.ttf': '',
    });
    expect(detect(inter, mono, 'apps/web/public/fonts/Brand.ttf')).toMatchObject({ id: 'unknown', open: false });
  });

  it('takes an OFL file at the root and a license file next to the font', () => {
    expect(
      detect(
        inter,
        tree({ 'package.json': JSON.stringify({ license: 'MIT' }), 'OFL.txt': OFL, 'public/fonts/Brand.ttf': '' }),
        'public/fonts/Brand.ttf',
      ),
    ).toMatchObject({ id: 'OFL-1.1', open: true, from: 'OFL.txt' });
    const near = tree({
      'package.json': JSON.stringify({ license: 'MIT' }),
      LICENSE: OFL,
      'public/fonts/LICENSE': APACHE,
      'public/fonts/Brand.ttf': '',
    });
    expect(detect(inter, near, 'public/fonts/Brand.ttf')).toMatchObject({
      id: 'Apache-2.0',
      open: true,
      from: 'public/fonts/LICENSE',
    });
    // One directory up, still below the root.
    expect(
      detect(inter, tree({ 'fonts/COPYING.txt': APACHE, 'fonts/brand/Brand.ttf': '' }), 'fonts/brand/Brand.ttf'),
    ).toMatchObject({ id: 'Apache-2.0', from: 'fonts/COPYING.txt' });
  });

  it("gives each font its own family's license file", () => {
    const root = tree({
      'package.json': '{}',
      'public/fonts/Inter-LICENSE.txt': OFL,
      'public/fonts/Fraunces-LICENSE.txt': APACHE,
    });
    // By file name or by family: InterVariable.ttf and "Inter Variable" both start with Inter.
    expect(detect(inter, root, 'public/fonts/InterVariable.ttf')).toMatchObject({
      id: 'OFL-1.1',
      from: 'public/fonts/Inter-LICENSE.txt',
    });
    expect(detect(inter, root, 'public/fonts/a1b2c3.woff2')).toMatchObject({
      id: 'OFL-1.1',
      from: 'public/fonts/Inter-LICENSE.txt',
    });
    expect(detect(dejavu, root, 'public/fonts/Fraunces.woff2')).toMatchObject({
      id: 'Apache-2.0',
      from: 'public/fonts/Fraunces-LICENSE.txt',
    });
    expect(detect(dejavu, root, 'public/fonts/Brand.ttf')).toMatchObject({ id: 'unknown', open: false });
    expect(detect(dejavu, tree({ 'public/fonts/Fraunces-OFL.txt': OFL }), 'public/fonts/Brand.ttf')).toMatchObject({
      id: 'unknown',
      open: false,
    });
    // fixtures/fonts: family files at the root the planner passes for fonts outside the project.
    const fx = join(repo, 'fixtures/fonts');
    expect(detectLicense(dejavu, join(fx, 'DejaVuSans.ttf'), fx)).toMatchObject({
      id: 'Bitstream-Vera',
      from: 'DejaVu-LICENSE.txt',
    });
    expect(detectLicense(inter, join(fx, 'Inter-Regular-hinted.woff2'), fx)).toMatchObject({
      id: 'OFL-1.1',
      from: 'Inter-LICENSE.txt',
    });
  });

  it("reads a node_modules package's LICENSE and package.json license, up to the package root", () => {
    const pkg = tree({
      'package.json': JSON.stringify({ license: 'MIT' }),
      'node_modules/@fontsource/x/package.json': JSON.stringify({ name: '@fontsource/x', license: 'OFL-1.1' }),
      'node_modules/@fontsource/x/files/x-latin-400-normal.woff2': '',
    });
    expect(detect(inter, pkg, 'node_modules/@fontsource/x/files/x-latin-400-normal.woff2')).toMatchObject({
      id: 'OFL-1.1',
      open: true,
      from: 'node_modules/@fontsource/x/package.json',
    });
    const lic = tree({
      'node_modules/x-font/LICENSE': OFL,
      'node_modules/x-font/package.json': '{}',
      'node_modules/x-font/fonts/x.woff2': '',
    });
    expect(detect(inter, lic, 'node_modules/x-font/fonts/x.woff2')).toMatchObject({
      id: 'OFL-1.1',
      from: 'node_modules/x-font/LICENSE',
    });
    const none = tree({
      LICENSE: APACHE,
      'node_modules/LICENSE': APACHE,
      'node_modules/@fontsource/x/package.json': '{}',
      'node_modules/@fontsource/x/files/x.woff2': '',
    });
    expect(detect(inter, none, 'node_modules/@fontsource/x/files/x.woff2')).toMatchObject({
      id: 'unknown',
      open: false,
    });
  });
});

describe('Reserved Font Names (§11)', () => {
  const rfn = (header: string) =>
    detect(inter, tree({ 'OFL.txt': `${header}\n\n${OFL}`, 'f.ttf': '' }), 'f.ttf').reserved;
  it('reads quoted and unquoted forms', () => {
    expect(rfn('Copyright (c) 2010, Pablo Impallari (www.impallari.com), with Reserved Font Name "Lobster".')).toEqual([
      'Lobster',
    ]);
    expect(
      rfn(
        'Copyright (c) 2010, Pablo Impallari (www.impallari.com|impallari@gmail.com),\nwith Reserved Font Name Lobster.',
      ),
    ).toEqual(['Lobster']);
    expect(
      rfn('Copyright (c) 2009, Mark Simonson (http://www.ms-studio.com), with Reserved Font Name Anonymous Pro.'),
    ).toEqual(['Anonymous Pro']);
    expect(rfn('Copyright (c) 2010, The League of Moveable Type, with Reserved Font Name: "League Gothic".')).toEqual([
      'League Gothic',
    ]);
    expect(rfn('Copyright (c) 2012, Mozilla Foundation with Reserved Font Name < Fira >,')).toEqual(['Fira']);
    expect(rfn('Copyright (c) 2014, Mozilla Foundation, with Reserved Font Names "Fira Sans" and "Fira Mono"')).toEqual(
      ['Fira Mono', 'Fira Sans'],
    );
    expect(rfn('Copyright 2010 Adobe, with Reserved Font Name ‘Source’.')).toEqual(['Source']);
    expect(rfn('Copyright 2020 X, with Reserved Font Names Foo 2, Bar & Baz Text.')).toEqual([
      'Bar',
      'Baz Text',
      'Foo 2',
    ]);
    expect(
      rfn(
        'Copyright 2020 X, with Reserved Font Name Foo\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.',
      ),
    ).toEqual(['Foo']);
  });
  it("doesn't read the licence's own sentences", () => {
    expect(OFL).toMatch(/"Reserved Font Name" refers/);
    expect(OFL).toMatch(/Reserved Font\s+Name\(s\) unless/);
    expect(rfn('Copyright 2016 The Inter Project Authors')).toEqual([]);
    expect(rfn('"Reserved Font Name" refers to any names specified as such after the copyright statement(s).')).toEqual(
      [],
    );
    expect(
      rfn(
        'No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted.',
      ),
    ).toEqual([]);
    expect(rfn('A Reserved Font Name is not a trademark.')).toEqual([]);
  });
});

describe('renames (§11)', () => {
  const plan = async (cssFamily: string, cfg: PlanConfig = {}) => {
    const bytes = fixture('DejaVuSans.ttf');
    const face: UsageFaceJson = {
      family: cssFamily,
      descriptors: { 'font-family': cssFamily, src: 'url(f.ttf)' },
      source: { adapter: 'css', fontFile: 'f.ttf' },
      files: [{ url: '/f.ttf', bytes: bytes.byteLength }],
      chars: 'U+20-7E',
      count: 95,
      inserted: {},
      contexts: [],
      rendered: {},
      declared: {},
      features: [],
      locales: [],
      pages: ['/'],
    };
    const usage = {
      version: 1,
      meta: {},
      faces: { x: face },
      pages: { '/': { faces: { x: 'U+20-7E' }, bytes: 0, fonts: [] } },
    } as unknown as UsageFileJson;
    const license: License = { id: 'OFL-1.1', open: true, reserved: ['DejaVu'], from: 'OFL.txt' };
    const outputs = new Map<string, Uint8Array>();
    const p = await planFace(
      'x',
      face,
      usage,
      { bytes, file: 'f.ttf', license },
      { remainder: false, ...cfg },
      outputs,
    );
    const names = nameStrings(await toSfnt([...outputs.values()][0]!));
    return {
      rename: p.license?.rename,
      family: names.get(1),
      full: names.get(4),
      ps: names.get(6),
      css: p.descriptors?.['font-family'],
    };
  };
  it("renames from the font's own family, whatever the CSS family", async () => {
    const to = deriveName('DejaVu Sans', ['DejaVu'])!;
    for (const css of ['DejaVu Sans', 'Body']) {
      const r = await plan(css);
      expect(r.rename).toEqual({ from: 'DejaVu Sans', to });
      expect(r.family).toBe(to);
      expect(r.full).not.toContain('DejaVu');
      expect(r.ps).toBe(to.replace(/\s+/g, ''));
      expect(r.css).toBeUndefined(); // descriptors unchanged: the CSS keeps its font-family
    }
  });
  it('takes `rename` keyed by the CSS family or the font family', async () => {
    expect(await plan('Body', { rename: { Body: 'Body Subset' } })).toMatchObject({
      rename: { from: 'DejaVu Sans', to: 'Body Subset' },
      family: 'Body Subset',
    });
    expect(await plan('Body', { rename: { 'DejaVu Sans': 'Sans Subset' } })).toMatchObject({
      rename: { from: 'DejaVu Sans', to: 'Sans Subset' },
      family: 'Sans Subset',
    });
    expect(await plan('DejaVu Sans', { rename: { 'DejaVu Sans': 'Sans Subset' } })).toMatchObject({
      family: 'Sans Subset',
    });
  });
});
