// M3: the planner (§8) and its golden plans. Golden inputs are fixtures/plans/<fixture>/usage.json,
// written by the crawler tests (`pnpm plans:update` regenerates both usage and plans).
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  closure,
  cldrLocale,
  codePointsOf,
  deriveName,
  detectLicense,
  licenseRefusal,
  limitAxes,
  loadFont,
  localeChars,
  parseFvar,
  parseUnicodeRange,
  planAll,
  planFace,
  readSfnt,
  resolveSources,
  toSfnt,
  withTables,
  type FacePlan,
  type UsageFaceJson,
  type UsageFileJson,
} from '../src/index.ts';
import { fixture } from './helpers.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cps = (r: string) => new Set(codePointsOf(parseUnicodeRange(r)));
const ranges = (s: string) => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`).join(',');

function face(over: Partial<UsageFaceJson> & { text?: string; words?: string[] } = {}): UsageFaceJson {
  const { text = 'Hello café', words = ['Hello ', ' café'], ...rest } = over;
  return {
    family: 'Inter',
    descriptors: { 'font-family': 'Inter', 'font-weight': '100 900' },
    source: { adapter: 'css', fontFile: 'InterVariable.ttf' },
    files: [{ url: '/InterVariable.ttf', bytes: 879708 }],
    chars: ranges(text),
    count: [...text].length,
    inserted: {},
    contexts: [{ features: '', axes: { wght: [400, 400], opsz: [16, 16] }, words }],
    rendered: { weight: [400], axes: { wght: [400], opsz: [16] } },
    declared: {},
    features: [],
    locales: ['en'],
    pages: ['/', '/a'],
    ...rest,
  };
}
const usageOf = (
  faces: Record<string, UsageFaceJson>,
  pages: Record<string, Record<string, string>> = {},
): UsageFileJson => ({
  version: 1,
  meta: {
    fontphobia: 't',
    harfbuzz: 't',
    chrome: 't',
    framework: 'static',
    mode: 'static',
    viewports: [1280],
    fontSizes: [16],
  },
  faces,
  pages: Object.fromEntries(Object.entries(pages).map(([p, f]) => [p, { faces: f, bytes: 0, fonts: [] }])),
});
const inter = { bytes: fixture('InterVariable.ttf'), file: 'InterVariable.ttf' };
const filesOf = (p: FacePlan) => Object.fromEntries((p.files ?? []).map((f) => [f.role, cps(f.unicodeRange)]));

describe('planner (§8)', () => {
  it('splits K into disjoint core, extended and rest files that cover everything the face serves', async () => {
    const f = face();
    const pages = {
      '/': { inter: ranges('Hello') },
      '/a': { inter: ranges('Hello') },
      '/b': { inter: ranges('Hello café') },
    };
    const p = await planFace('inter', { ...f, pages: Object.keys(pages) }, usageOf({ inter: f }, pages), inter);
    expect(p.status).toBe('planned');
    const { core, ext, rest } = filesOf(p);
    for (const [a, b] of [
      [core, ext],
      [core, rest],
      [ext, rest],
    ] as const)
      expect([...a!].filter((c) => b!.has(c))).toEqual([]);
    const cmap = new Set(loadFont(fixture('InterVariable.ttf')).face.collectUnicodes());
    const servable = [...cmap].filter((c) => c >= 0x20 && !(c >= 0x7f && c < 0xa0));
    expect(new Set([...core!, ...ext!, ...rest!])).toEqual(new Set(servable));
    // Printable ASCII is core; Latin-1 and Latin Extended-A are kept (extended), the rest is lazy.
    for (const c of 'Az~\\') expect(core!.has(c.codePointAt(0)!)).toBe(true);
    for (const c of 'ñŁ') expect(ext!.has(c.codePointAt(0)!)).toBe(true);
    expect(rest!.has('Ω'.codePointAt(0)!)).toBe(true);
    // "café": é met core letters and kerned differently split, so the repair moved it into core.
    expect(p.repair?.words).toEqual([' café']);
    expect(core!.has('é'.codePointAt(0)!)).toBe(true);
    expect(p.optIns!.map((o) => o.id)).toEqual(['drop-hint-refs', 'limit-axes', 'split-shaping']);
    expect(p.optIns!.every((o) => !o.applied)).toBe(true);
    // One accented letter in core is within WOFF2's compression noise (±100 bytes); limit-axes is not.
    expect(Math.abs(p.optIns!.find((o) => o.id === 'split-shaping')!.saving)).toBeLessThan(200);
    expect(p.optIns!.find((o) => o.id === 'limit-axes')!.saving).toBeGreaterThan(10_000);
  }, 60_000);

  it('puts characters most pages use in core, rarer ones in extended', async () => {
    const f = face({ text: 'ab¿¡', words: [] });
    const pages = { '/1': { i: ranges('ab¿') }, '/2': { i: ranges('ab¿') }, '/3': { i: ranges('ab¡') } };
    const p = await planFace('i', { ...f, pages: Object.keys(pages) }, usageOf({ i: f }, pages), inter, {
      remainder: false,
    });
    const { core, ext, rest } = filesOf(p);
    expect(core!.has(0xbf)).toBe(true); // ¿ on 2 of 3 pages
    expect(ext!.has(0xa1)).toBe(true); // ¡ on 1 of 3
    expect(rest).toBeUndefined();
    const strict = await planFace('i', { ...f, pages: Object.keys(pages) }, usageOf({ i: f }, pages), inter, {
      remainder: false,
      coreThreshold: 1,
    });
    expect(filesOf(strict).ext!.has(0xbf)).toBe(true);
  }, 60_000);

  it('adds locale characters, every Latin character for inputs, and respects unicode-range', async () => {
    const ro = await planFace('i', face({ locales: ['ro', 'vi'], words: [] }), usageOf({}), inter, {
      remainder: false,
    });
    const k = new Set(Object.values(filesOf(ro)).flatMap((s) => [...s]));
    for (const c of 'șțẞ₫ơ') expect(k.has(c.codePointAt(0)!), c).toBe(c === 'ẞ' ? k.has(0x1e9e) : true);
    expect(ro.kept!.locales).toEqual(['ro', 'vi']);
    const typed = await planFace('i', face({ editable: true, words: [] }), usageOf({}), inter, { remainder: false });
    expect(typed.kept!.count).toBeGreaterThan(ro.kept!.count + 500);
    const sliced = await planFace(
      'i',
      face({ descriptors: { 'font-family': 'Inter', 'unicode-range': 'U+0-FF' }, words: [] }),
      usageOf({}),
      inter,
    );
    expect(Math.max(...Object.values(filesOf(sliced)).flatMap((s) => [...s]))).toBeLessThanOrEqual(0xff);
  }, 60_000);

  it('applies opt-ins only when allowed, and measures each one', async () => {
    const f = face();
    const pages = {
      '/': { inter: ranges('Hello') },
      '/a': { inter: ranges('Hello') },
      '/b': { inter: ranges('Hello café') },
    };
    const p = await planFace('inter', { ...f, pages: Object.keys(pages) }, usageOf({ inter: f }, pages), inter, {
      remainder: false,
      allow: ['limit-axes', 'split-shaping'],
    });
    expect(p.axes).toEqual({ opsz: 16, wght: { min: 400, max: 700 } });
    expect(p.descriptors).toEqual({ 'font-weight': '400 700' });
    expect(p.repair).toBeUndefined();
    expect(p.splitWords).toEqual([' café']);
    expect(filesOf(p).core!.has('é'.codePointAt(0)!)).toBe(false);
    expect(p.optIns!.filter((o) => o.applied).map((o) => o.id)).toEqual(['limit-axes', 'split-shaping']);
    const dv = await planFace(
      'd',
      face({ family: 'DejaVu', words: [] }),
      usageOf({}),
      { bytes: fixture('DejaVuSans.ttf'), file: 'DejaVuSans.ttf' },
      { remainder: false, allow: ['drop-hinting'] },
    );
    expect(dv.hinting).toBe(false);
    expect(dv.optIns!.find((o) => o.id === 'drop-hinting')).toMatchObject({ applied: true });
    expect(dv.optIns!.find((o) => o.id === 'drop-hinting')!.saving).toBeGreaterThan(5000);
  }, 60_000);

  it('limits axes to what renders, keeping browser bold and the default inside ranges', () => {
    const axes = parseFvar(fixture('InterVariable.ttf'))!.axes;
    expect(limitAxes(face(), axes)).toEqual({ opsz: 16, wght: { min: 400, max: 700 } });
    expect(
      limitAxes(face({ rendered: { weight: [300, 700], axes: { wght: [300, 700], opsz: [14, 32] } } }), axes),
    ).toEqual({ opsz: { min: 14, max: 32 }, wght: { min: 300, max: 900 } });
    expect(limitAxes(face({ descriptors: { 'font-weight': '400' } }), axes)).toEqual({ opsz: 16, wght: 400 });
  });

  it('skips faces it may not change, and refuses restricted or unknown licenses', async () => {
    expect(await planFace('g', face({ source: { adapter: 'google-fonts' } }), usageOf({}), undefined)).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/Google serves/),
    });
    expect(await planFace('l', face({ local: true }), usageOf({}), inter)).toMatchObject({ status: 'skipped' });
    expect(await planFace('m', face(), usageOf({}), undefined)).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/not found/),
    });
    const sfnt = await toSfnt(fixture('InterVariable.ttf'));
    const os2 = readSfnt(sfnt).tables.get('OS/2')!.slice();
    new DataView(os2.buffer).setUint16(8, 0x0002);
    const restricted = withTables(sfnt, { 'OS/2': os2 });
    expect(await planFace('r', face(), usageOf({}), { bytes: restricted, file: 'x.ttf' })).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/restricted/),
    });
    const unknown = { id: 'unknown', open: false, reserved: [], from: 'name table' };
    expect(licenseRefusal(sfnt, unknown, false)).toMatch(/licenses\.allow/);
    expect(licenseRefusal(sfnt, unknown, true)).toBeUndefined();
  });
});

describe('licenses (§11)', () => {
  it('reads the license and reserved names', async () => {
    expect(detectLicense(await toSfnt(fixture('InterVariable.ttf')))).toMatchObject({
      id: 'OFL-1.1',
      open: true,
      reserved: [],
    });
    expect(detectLicense(await toSfnt(fixture('DejaVuSans.ttf')))).toMatchObject({
      id: 'Bitstream-Vera',
      open: true,
      reserved: ['Bitstream', 'Vera'],
    });
    expect(deriveName('Source Serif 4', ['Source'])).toBe('Src Serif 4 Subset');
    const ofl = readFileSync(join(repo, 'fixtures/fonts/Inter-LICENSE.txt'), 'utf8');
    expect(ofl).toMatch(/"Reserved Font Name" refers/);
    const dir = mkdtempSync(join(tmpdir(), 'fontphobia-lic-'));
    writeFileSync(join(dir, 'OFL.txt'), 'Copyright 2010 Adobe, with Reserved Font Name \u2018Source\u2019.\n\n' + ofl);
    writeFileSync(join(dir, 'f.ttf'), '');
    expect(detectLicense(await toSfnt(fixture('InterVariable.ttf')), join(dir, 'f.ttf'), dir).reserved).toEqual([
      'Source',
    ]);
    writeFileSync(join(dir, 'OFL.txt'), ofl);
    expect(detectLicense(await toSfnt(fixture('InterVariable.ttf')), join(dir, 'f.ttf'), dir).reserved).toEqual([]);
    expect(deriveName('DejaVu Sans', ['Bitstream', 'Vera'])).toBeUndefined();
  });
});

describe('locale characters', () => {
  it('maps tags to CLDR and has the letters the plan names', () => {
    expect(cldrLocale('en-US')).toBe('en');
    expect(cldrLocale('en-AU')).toBe('en-AU');
    expect(cldrLocale('pt-BR')).toBe('pt');
    expect(cldrLocale('xx-YY')).toBeUndefined();
    const has = (tag: string, s: string) => [...s].every((c) => localeChars(tag)!.includes(c.codePointAt(0)!));
    expect(has('ro', 'șțȘȚ')).toBe(true);
    expect(has('vi', 'ơưƠƯ₫ạ')).toBe(true);
    expect(has('de', 'ßẞ€')).toBe(true);
  });
  it('closes sets under bidi mirroring, as HarfBuzz does', () => {
    expect([...closure(fixture('DejaVuSans.ttf'), new Set([0x3e]))].toSorted()).toEqual([0x3c, 0x3e]);
  });
});

// ─── Golden plans ───────────────────────────────────────────────────────────────────────────────

const plans = join(repo, 'fixtures/plans');
const names = existsSync(plans)
  ? readdirSync(plans)
      .filter((n) => existsSync(join(plans, n, 'usage.json')))
      .toSorted()
  : [];

describe('golden plans', () => {
  if (!names.length) it.skip('no golden inputs yet (pnpm plans:update)', () => {});
  for (const name of names) {
    it(`${name}: plans exactly as committed`, async (ctx) => {
      const usage = JSON.parse(readFileSync(join(plans, name, 'usage.json'), 'utf8')) as UsageFileJson;
      const root = join(repo, 'fixtures/sites', name);
      const sources = await resolveSources(root, usage, { searchDirs: [join(repo, 'fixtures/fonts')] });
      // Framework fixtures' fontsource files live in their node_modules (the `sites` CI job installs them).
      const missing = Object.entries(usage.faces).filter(
        ([id, f]) => ['css', 'fontsource'].includes(f.source.adapter) && !sources.has(id),
      );
      if (missing.length && !process.env.FONTPHOBIA_SITES)
        return ctx.skip(`sources not installed: ${missing.map(([id]) => id).join(', ')}`);
      const plan = canonicalJson(await planAll(usage, sources));
      const file = join(plans, name, 'plan.json');
      if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, plan);
      expect(plan).toBe(readFileSync(file, 'utf8'));
    }, 180_000);
  }
});
