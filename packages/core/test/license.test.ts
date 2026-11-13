// §11: where a font's license may come from, OFL Reserved Font Names, and the internal rename.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cffNames,
  checkShaping,
  deriveName,
  detectLicense,
  hbSubset,
  licenseRefusal,
  loadFont,
  nameStrings,
  numGlyphs,
  parseName,
  planFace,
  postProcess,
  readSfnt,
  RENAMED_IDS,
  renameCff,
  subsetFont,
  toSfnt,
  withTables,
  woff2Decompress,
  type License,
  type PlanConfig,
  type UsageFaceJson,
  type UsageFileJson,
} from '../src/index.ts';
import { ASCII, fixture } from './helpers.ts';

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
  const plan = async (cssFamily: string, cfg: PlanConfig = {}, font = 'DejaVuSans.ttf', reserved = ['DejaVu']) => {
    const bytes = fixture(font);
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
    const license: License = { id: 'OFL-1.1', open: true, reserved, from: 'OFL.txt' };
    const outputs = new Map<string, Uint8Array>();
    const p = await planFace(
      'x',
      face,
      usage,
      { bytes, file: 'f.ttf', license },
      { remainder: false, ...cfg },
      outputs,
    );
    const out = await toSfnt([...outputs.values()][0]!);
    const names = nameStrings(out);
    return {
      out,
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

  describe('CFF fonts', () => {
    const cffOf = (sfnt: Uint8Array) => readSfnt(sfnt).tables.get('CFF ')!;
    const sourceSans = fixture('SourceSans3-Regular.otf');
    const unicodes = new Set(ASCII);
    const texts = [
      'The quick brown fox jumps over the lazy dog. 0123456789',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ & (?!) {}[]',
      'fi ffl Th AVATAR WAVE',
    ];

    /** Every glyph's outline and advance, and shaping `cases`, against the unrenamed subset. */
    const sameGlyphs = (plain: Uint8Array, renamed: Uint8Array, cases: string[]) => {
      const a = loadFont(plain).font,
        b = loadFont(renamed).font;
      expect(numGlyphs(renamed)).toBe(numGlyphs(plain));
      for (let g = 0; g < numGlyphs(plain); g++) {
        expect(b.glyphToJson(g), `glyph ${g}`).toEqual(a.glyphToJson(g));
        expect(b.glyphHAdvance(g), `glyph ${g}`).toBe(a.glyphHAdvance(g));
      }
      const shaped = checkShaping(
        plain,
        [{ sfnt: renamed, ranges: [[0, 0x10ffff]] }],
        cases.map((text) => ({ text })),
      );
      expect(shaped.map((r) => r.verdict)).toEqual(cases.map(() => ({ kind: 'identical' })));
    };

    it('the fixture declares the Reserved Font Name "Source"', () => {
      const fx = join(repo, 'fixtures/fonts');
      expect(detectLicense(sourceSans, join(fx, 'SourceSans3-Regular.otf'), fx)).toMatchObject({
        id: 'OFL-1.1',
        reserved: ['Source'],
      });
    });

    it('the planner renames in the name table and the CFF table', async () => {
      const to = deriveName('Source Sans 3', ['Source'])!;
      const r = await plan('Source Sans 3', {}, 'SourceSans3-Regular.otf', ['Source']);
      expect(r.rename).toEqual({ from: 'Source Sans 3', to });
      expect(r.family).toBe(to);
      expect(cffNames(cffOf(r.out))).toMatchObject({ fontName: `${to.replace(/\s+/g, '')}-Regular`, familyName: to });
    });

    describe.each([
      ['longer', 'Srce Sans 3 Subset'],
      ['shorter', 'S3'],
    ])('to a %s name', (_, to) => {
      const ps = to.replace(/\s+/g, '');
      const rename = { from: 'Source Sans 3', to };
      const both = (async () => ({
        plain: await subsetFont(sourceSans, { unicodes }),
        renamed: await subsetFont(sourceSans, { unicodes, rename }),
      }))();

      it('rewrites the family-bearing name records, and the reserved word is gone from them', async () => {
        const { renamed } = await both;
        const names = nameStrings(renamed.decoded);
        expect(names.get(1)).toBe(to);
        expect(names.get(4)).toBe(to);
        expect(names.get(6)).toBe(`${ps}-Regular`);
        expect(names.get(3)).toBe(`3.052;ADBO;${ps}-Regular;ADOBE`);
        for (const r of parseName(renamed.decoded).filter((x) => RENAMED_IDS.has(x.nameID)))
          expect(r.value, `name ID ${r.nameID}`).not.toContain('Source');
      });

      it('rewrites the CFF FontName and FamilyName, and keeps Notice, Copyright and version', async () => {
        const { plain, renamed } = await both;
        const before = cffNames(cffOf(plain.decoded));
        const after = cffNames(cffOf(renamed.decoded));
        expect(before).toMatchObject({ fontName: 'SourceSans3-Regular', familyName: 'Source Sans 3', cidKeyed: false });
        expect(after).toMatchObject({ fontName: `${ps}-Regular`, familyName: to });
        for (const s of [after.fontName, after.fullName, after.familyName]) expect(s ?? '').not.toContain('Source');
        // Strings decode one byte per character, so equal strings are equal bytes.
        expect(after.notice).toBe(before.notice);
        expect(after.copyright).toBe(before.copyright);
        expect(after.version).toBe(before.version);
        expect(after.copyright).toContain("Reserved Font Name 'Source'");
      });

      it('shifts everything after the String INDEX both ways', async () => {
        const { plain, renamed } = await both;
        const grew = to.length > rename.from.length;
        expect(cffOf(renamed.decoded).length - cffOf(plain.decoded).length > 0).toBe(grew);
      });

      it('draws and shapes exactly as the unrenamed subset', async () => {
        const { plain, renamed } = await both;
        sameGlyphs(plain.decoded, renamed.decoded, texts);
      });

      it('survives the WOFF2 round trip with its CFF table unchanged', async () => {
        const opts = { unicodes, rename };
        const processed = postProcess(sourceSans, hbSubset(sourceSans, opts), opts);
        const { woff2, decoded } = await subsetFont(sourceSans, opts);
        expect(cffOf(await woff2Decompress(woff2))).toEqual(cffOf(processed));
        expect(cffOf(decoded)).toEqual(cffOf(processed));
      });
    });

    describe('CID-keyed', () => {
      const notdef = fixture('AND-Regular.otf');
      const text = 'AZaz09一中𠀀';
      const cps = new Set([...text].map((c) => c.codePointAt(0)!));
      const plain = subsetFont(notdef, { unicodes: cps });

      it('rewrites the Name INDEX and the Font DICT FontNames, and shifts the Font DICT Private offsets', async () => {
        const renamed = await subsetFont(notdef, { unicodes: cps, rename: { from: 'AND', to: 'Box Font' } });
        const before = cffNames(cffOf((await plain).decoded));
        expect(before).toMatchObject({ fontName: 'AND-Regular', fdFontNames: ['AND-Regular-Generic'], cidKeyed: true });
        expect(cffNames(cffOf(renamed.decoded))).toEqual({
          ...before,
          fontName: 'BoxFont-Regular',
          fdFontNames: ['BoxFont-Regular-Generic'],
        });
        expect(nameStrings(renamed.decoded).get(6)).toBe('BoxFont-Regular');
        sameGlyphs((await plain).decoded, renamed.decoded, [text]);
      });

      it('rewrites FullName and FamilyName', async () => {
        const to = 'A Considerably Longer Box Family';
        const renamed = await subsetFont(notdef, { unicodes: cps, rename: { from: 'Adobe NotDef', to } });
        const before = cffNames(cffOf((await plain).decoded));
        expect(cffNames(cffOf(renamed.decoded))).toEqual({ ...before, fullName: to, familyName: to });
        sameGlyphs((await plain).decoded, renamed.decoded, [text]);
      });

      it("refuses when a Font DICT's Private offset can't hold the shifted value at its width", () => {
        // makeotf writes this offset as a 3-byte integer (HarfBuzz writes 5 bytes), so a big enough shift overflows it.
        const cff = cffOf(notdef);
        expect(cffNames(renameCff(cff, 'AND', 'Box Font')).fontName).toBe('BoxFont-Regular');
        expect(() => renameCff(cff, 'AND', 'X'.repeat(20_000))).toThrow(
          /Font DICT 0's Private offset is a 3-byte number and can't hold/,
        );
      });
    });
  });
});
