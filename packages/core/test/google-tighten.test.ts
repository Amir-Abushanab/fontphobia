// google-fonts "tighten" (§6.5): the URL rewrite, and build/check/revert on a small project.
// No network: tighten without limit-axes never fetches.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildProject,
  checkProject,
  createOverlay,
  readManifest,
  revertProject,
  type UsageFaceJson,
  type UsageFileJson,
} from '../src/index.ts';
import { desiredWeights, matchWeight, neededWeights, parseCss2, tightenCss2 } from '../src/adapters/google-url.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-google-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const G = 'https://fonts.googleapis.com/css2';

describe('css2 URLs', () => {
  it('parses families, axes and tuples, and refuses what it can’t rewrite', () => {
    const p = parseCss2(`${G}?family=Open+Sans:ital,wght@0,400;1,700&family=Lora&display=swap`)!;
    expect(p.families.map((f) => [f.name, f.axes, f.tuples])).toEqual([
      [
        'Open Sans',
        ['ital', 'wght'],
        [
          ['0', '400'],
          ['1', '700'],
        ],
      ],
      ['Lora', [], []],
    ]);
    expect(parseCss2(`${G}?family=Inter&text=Hello`)).toBeUndefined();
    expect(parseCss2('https://fonts.googleapis.com/css?family=Roboto:400,700')).toBeUndefined();
    expect(parseCss2(`${G}?family=Inter:wght@4x0`)).toBeUndefined();
  });

  it('matches weights the way CSS does', () => {
    const w = [300, 400, 500, 700];
    expect([100, 300, 400, 450, 600, 900].map((d) => matchWeight(d, w))).toEqual([300, 300, 400, 500, 700, 700]);
    expect(matchWeight(450, [300, 700])).toBe(300);
  });

  it('collects the weights the code can ask for, closed under bolder', () => {
    const d = desiredWeights([
      { text: '.a { font-weight: 300 } .b { font: italic 600 1rem/1 X } <p class="font-medium">' },
    ])!;
    expect([...d].toSorted((a, b) => a - b)).toEqual([300, 400, 500, 600, 700, 900]);
    expect(desiredWeights([{ text: '.a { font-weight: var(--w) }' }])).toBeUndefined();
    expect(
      [...desiredWeights([{ text: '@font-face { font-family: X; font-weight: 100 900; }' }])!].toSorted(
        (a, b) => a - b,
      ),
    ).toEqual([400, 700, 900]);
    expect(desiredWeights([{ text: 'style={{ fontWeight: props.w }}' }])).toBeUndefined();
    expect([...desiredWeights([{ text: '.a { font-weight: lighter }' }])!].toSorted((a, b) => a - b)).toEqual([
      100, 400, 700, 900,
    ]);
  });

  it('drops unused families and unmatched static weights, never ranges or ital', () => {
    const sheet = `${G}?family=Inter:ital,wght@0,300;0,400;0,500;0,700;1,400&family=Lora&family=Fraunces:wght@100..900&display=swap`;
    const t = tightenCss2({
      sheet,
      loaded: [
        { family: 'Inter', rendered: { wght: [400] } },
        { family: 'Fraunces', rendered: { wght: [700] } },
      ],
      named: () => [],
      weights: new Set([400, 700, 900]),
    })!;
    expect(t.url).toBe(`${G}?family=Inter:ital,wght@0,400;0,700;1,400&family=Fraunces:wght@100..900&display=swap`);
    expect(t.families).toEqual(['Lora']);
    expect(t.weights).toEqual({ Inter: [300, 500] });
    // A family the code names stays even if no crawled page loaded it.
    expect(
      tightenCss2({
        sheet: `${G}?family=Inter&family=Lora`,
        loaded: [{ family: 'Inter', rendered: {} }],
        named: (f) => (f === 'Lora' ? ['src/a.css'] : []),
        weights: undefined,
      }),
    ).toBeUndefined();
    // Computed weights: none dropped.
    expect(
      tightenCss2({
        sheet: `${G}?family=Inter:wght@300;400`,
        loaded: [{ family: 'Inter', rendered: {} }],
        named: () => [],
        weights: undefined,
      }),
    ).toBeUndefined();
  });

  it('drops a default-only axis with limit-axes, and keeps it when a use differs or the code sets it', () => {
    const sheet = `${G}?family=Inter:opsz,wght@14..32,100..900`;
    const base = {
      sheet,
      named: () => [],
      weights: new Set([400, 700]),
      axisDefaults: new Map([['inter', { opsz: 14, wght: 400 }]]),
    };
    expect(tightenCss2({ ...base, loaded: [{ family: 'Inter', rendered: { opsz: [14], wght: [400] } }] })!.url).toBe(
      `${G}?family=Inter:wght@100..900`,
    );
    expect(tightenCss2({ ...base, loaded: [{ family: 'Inter', rendered: { opsz: [14, 16] } }] })).toBeUndefined();
    expect(
      tightenCss2({
        ...base,
        loaded: [{ family: 'Inter', rendered: { opsz: [14] } }],
        variationTags: new Map([['*', new Set(['opsz'])]]),
      }),
    ).toBeUndefined();
    // A pinned value isn't the default.
    expect(
      tightenCss2({
        ...base,
        sheet: `${G}?family=Inter:opsz,wght@32,100..900`,
        loaded: [{ family: 'Inter', rendered: {} }],
      }),
    ).toBeUndefined();
  });

  it('says which dropped weights a site asks for again', () => {
    const from = `${G}?family=Inter:wght@300;400;500;700`;
    expect(neededWeights(from, 'Inter', [300, 500], new Set([400, 700, 900]))).toEqual([]);
    expect(neededWeights(from, 'Inter', [300, 500], new Set([300, 400, 700, 900]))).toEqual([300]);
    expect(neededWeights(from, 'Inter', [300, 500], undefined)).toEqual([300, 500]);
  });
});

const face = (family: string, weight: string, sheet: string, loaded: boolean): UsageFaceJson => ({
  family: `'${family}'`,
  descriptors: {
    'font-family': `'${family}'`,
    'font-weight': weight,
    'font-style': 'normal',
    src: `url(https://fonts.gstatic.com/s/${family.toLowerCase()}/v1/${weight}.woff2) format('woff2')`,
  },
  source: { adapter: 'google-fonts' },
  sheet,
  files: loaded
    ? [
        {
          url: `https://fonts.gstatic.com/s/${family.toLowerCase()}/v1/${weight}.woff2`,
          sha256: '0'.repeat(64),
          bytes: 1000,
        },
      ]
    : [],
  chars: 'Hello',
  count: 5,
  inserted: {},
  contexts: [],
  rendered: loaded ? { weight: [Number(weight)], style: ['normal'], axes: {} } : {},
  declared: {},
  features: [],
  locales: ['en'],
  pages: loaded ? ['/'] : [],
});

function usageFor(
  sheet: string,
  families: Record<string, string[]>,
): UsageFileJson & { unloaded: Record<string, unknown> } {
  const faces: Record<string, UsageFaceJson> = {},
    unloaded: Record<string, unknown> = {};
  for (const [fam, ws] of Object.entries(families))
    for (const w of ws) {
      const loaded = fam === 'Inter' && w === '400';
      const f = face(fam, w, sheet, loaded);
      if (loaded) faces[`${fam.toLowerCase()}-${w}-normal`] = f;
      else
        unloaded[`${fam.toLowerCase()}-${w}-normal`] = {
          family: f.family,
          descriptors: f.descriptors,
          sheet,
          urls: [],
        };
    }
  return {
    version: 1,
    meta: {
      fontphobia: '1',
      harfbuzz: '1',
      chrome: '150.0.0.0',
      framework: 'static',
      mode: 'static',
      viewports: [1280],
      fontSizes: [16],
    },
    faces,
    pages: { '/': { faces: { 'inter-400-normal': '1280' }, bytes: 1000, fonts: [] } },
    unloaded,
  };
}

describe('build, check and revert with tighten', () => {
  it('rewrites the link, keeps the original for revert, and check reports what comes back', async () => {
    const root = mkdtempSync(join(tmp, 'site-'));
    const sheet = `${G}?family=Inter:wght@300;400;500;700&family=Lora&display=swap`;
    const html = `<!doctype html><link rel="stylesheet" href="${sheet.replace(/&/g, '&amp;')}"><link rel="stylesheet" href="styles.css"><p>Hello</p>\n`;
    writeFileSync(join(root, 'index.html'), html);
    writeFileSync(join(root, 'styles.css'), 'body { font-family: Inter, sans-serif; }\n');
    writeFileSync(join(root, 'package.json'), '{"name":"t","private":true}\n');
    const u = usageFor(sheet, { Inter: ['300', '400', '500', '700'], Lora: ['400'] });

    // Default: measured and reported, nothing edited.
    const def = await buildProject(root, u, {}, { version: '1', write: true });
    expect(def.edits).toEqual([]);
    expect(def.suggestions.map((x) => x.kind === 'google' && [x.families, x.weights])).toEqual([
      [['Lora'], { Inter: [300, 500] }],
    ]);
    expect(def.suggestions[0]!.kind === 'google' && def.suggestions[0]!.cssBytes).toBeGreaterThan(100);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(html);
    expect(readManifest(root)).toBeUndefined();

    const tighten = { allow: ['tighten'] };
    const preview = await buildProject(root, u, tighten, { version: '1' });
    const want = `${G}?family=Inter:wght@400;700&family=Lora&display=swap`.replace('&family=Lora', '');
    expect(preview.edits.map((e) => [e.file, e.text])).toEqual([['index.html', want.replace(/&/g, '&amp;')]]);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(html);

    const r = await buildProject(root, u, tighten, { version: '1', write: true });
    expect(r.manifest.google).toEqual([
      {
        from: sheet,
        to: want,
        files: ['index.html'],
        dropped: { families: ['Lora'], weights: { Inter: [300, 500] }, axes: {} },
      },
    ]);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain(want.replace(/&/g, '&amp;'));
    // verify's "before" loads the original URL in its place.
    expect(createOverlay(r.manifest).originalSheet(want)).toBe(sheet);

    // The next audit sees the tightened URL: nothing more to do, and the original is kept (with or without the opt-in).
    const u2 = usageFor(want, { Inter: ['400', '700'] });
    const again = await buildProject(root, u2, {}, { version: '1', write: true });
    expect(again.edits).toEqual([]);
    expect(again.unchanged).toBe(true);
    expect(readManifest(root)!.google![0]!.from).toBe(sheet);

    expect((await checkProject({ root })).issues).toEqual([]);
    appendFileSync(join(root, 'styles.css'), '.thin { font-weight: 300; }\nh2 { font-family: Lora, serif; }\n');
    const c = await checkProject({ root });
    expect(c.ok).toBe(false);
    expect(c.issues.map((i) => i.message)).toEqual([
      'styles.css names Lora, which build dropped from the Google Fonts URL because nothing used it',
      'Inter 300 is asked for again, but build dropped it from the Google Fonts URL',
    ]);
    writeFileSync(join(root, 'styles.css'), 'body { font-family: Inter, sans-serif; }\n');

    const rv = revertProject(root, { write: true });
    expect(rv.problems).toEqual([]);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(html);
    expect(readManifest(root)).toBeUndefined();
  });
});
