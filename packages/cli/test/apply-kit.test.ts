// adobe-fonts --apply-kit (§6.6) against a stand-in for the Typekit API and Adobe's CDN.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readManifest, type UsageFileJson } from '@fontphobia/core';
import { applyKit, revertKits } from '../src/apply-kit.ts';

const inter = readFileSync(fileURLToPath(new URL('../../../fixtures/fonts/InterVariable.ttf', import.meta.url)));
const posts: Record<string, string>[] = [];
type Fam = { id: string; name: string; slug: string; css_names: string[]; subset: string; variations: string[] };
const start: Fam[] = [
  {
    id: 'gkmg',
    name: 'Inter',
    slug: 'inter',
    css_names: ['inter'],
    subset: 'all',
    variations: ['n3', 'n4', 'n7', 'i4'],
  },
];
// The stand-in keeps a draft and a published kit, as the Typekit API documents (POST edits the draft and replaces `families` whole).
const state = { draft: structuredClone(start), published: structuredClone(start), ignoreVariations: false };
const reset = (fams: Fam[]) => {
  state.draft = structuredClone(fams);
  state.published = structuredClone(fams);
  state.ignoreVariations = false;
};
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (req.headers['x-typekit-token'] !== 'tok' && req.url!.startsWith('/api')) {
        res.writeHead(401).end('{}');
        return;
      }
      if (req.method === 'GET' && req.url === '/api/kits/abc1234')
        return json({ kit: { id: 'abc1234', families: state.draft } });
      if (req.method === 'GET' && req.url === '/api/kits/abc1234/published')
        return json({ kit: { id: 'abc1234', families: state.published } });
      if (req.method === 'POST' && req.url === '/api/kits/abc1234') {
        const f = Object.fromEntries(new URLSearchParams(body));
        posts.push(f);
        const out: Fam[] = [];
        for (let i = 0; f[`families[${i}][id]`]; i++) {
          const old = start.find((x) => x.id === f[`families[${i}][id]`])!;
          out.push({
            ...old,
            subset: f[`families[${i}][subset]`] ?? 'default',
            variations: state.ignoreVariations
              ? old.variations
              : (f[`families[${i}][variations]`] ?? '').split(',').filter(Boolean),
          });
        }
        state.draft = out;
        return json({ kit: { id: 'abc1234', families: state.draft } });
      }
      if (req.method === 'POST' && req.url === '/api/kits/abc1234/publish') {
        posts.push({ publish: '1' });
        state.published = structuredClone(state.draft);
        return json({ published: '2026-11-04T00:00:00Z' });
      }
      if (req.url === '/css/abc1234.css') {
        res
          .writeHead(200, { 'content-type': 'text/css' })
          .end(
            `@font-face{font-family:"inter";src:url("${base}/af/1/l?fvd=n4") format("woff2");font-weight:400;font-style:normal}`,
          );
        return;
      }
      if (req.url!.startsWith('/af/')) {
        res.writeHead(200).end(inter);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.TYPEKIT_TOKEN = 'tok';
  process.env.TYPEKIT_API = `${base}/api`;
  process.env.TYPEKIT_CSS = `${base}/css`;
});
const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-kit-'));
afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.TYPEKIT_TOKEN;
  delete process.env.TYPEKIT_API;
  delete process.env.TYPEKIT_CSS;
});

/** usage.json stores `chars` as a unicode-range string. */
const ranges = (s: string) =>
  [...new Set([...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase()))].join(', ');
const usage = {
  version: 1,
  meta: {
    fontphobia: '1',
    harfbuzz: '1',
    chrome: '150',
    framework: 'static',
    mode: 'static',
    viewports: [1280],
    fontSizes: [16],
  },
  faces: {
    'inter-400-normal': {
      family: 'inter',
      descriptors: { 'font-weight': '400', 'font-style': 'normal' },
      sheet: 'https://use.typekit.net/abc1234.css',
      source: { adapter: 'adobe-fonts' },
      files: [],
      chars: ranges('Hello, café'),
      count: 9,
      inserted: {},
      contexts: [],
      rendered: { weight: [400] },
      declared: {},
      features: [],
      locales: ['en'],
      pages: ['/'],
    },
  },
  pages: {},
} as unknown as UsageFileJson;

describe('apply-kit', () => {
  it('removes styles nothing matches, leaves the character set, records the previous kit; --check and revert', async () => {
    const root = mkdtempSync(join(tmp, 'site-'));
    writeFileSync(join(root, 'styles.css'), 'body { font-family: inter, serif; }\n');
    const log: string[] = [];
    const o = { ask: async () => false, interactive: false, version: '1', log: (m: string) => log.push(m) };
    // Without --yes and no terminal: shown, not applied.
    expect(await applyKit(root, usage, o)).toBe(1);
    expect(log.join('\n')).toContain(
      'Inter: variations n3,n4,n7,i4 → n4,n7,i4 (no weight the site asks for matches n3)',
    );
    expect(posts).toEqual([]);
    expect(await applyKit(root, usage, { ...o, yes: true })).toBe(0);
    expect(posts).toEqual([
      { 'families[0][id]': 'gkmg', 'families[0][variations]': 'n4,n7,i4', 'families[0][subset]': 'all' },
      { publish: '1' },
    ]);
    expect(readManifest(root)!.kits).toEqual([
      {
        kit: 'abc1234',
        previous: [{ id: 'gkmg', variations: ['n3', 'n4', 'n7', 'i4'], subset: 'all' }],
        applied: [{ id: 'gkmg', variations: ['n4', 'n7', 'i4'], subset: 'all' }],
      },
    ]);
    // The live kit serves the face and every character.
    expect(await applyKit(root, usage, { ...o, check: true })).toBe(0);
    expect(
      await applyKit(
        root,
        { ...usage, faces: { x: { ...usage.faces['inter-400-normal']!, chars: ranges('Hello ☃') } } } as UsageFileJson,
        { ...o, check: true },
      ),
    ).toBe(1);
    expect(log.at(-1)).toContain('no longer has ☃');
    posts.length = 0;
    expect(await revertKits(root, () => {})).toEqual([]);
    expect(posts).toEqual([
      { 'families[0][id]': 'gkmg', 'families[0][variations]': 'n3,n4,n7,i4', 'families[0][subset]': 'all' },
      { publish: '1' },
    ]);
    expect(readManifest(root)?.kits).toBeUndefined();
    expect(state.published[0]!.variations).toEqual(['n3', 'n4', 'n7', 'i4']);
  });

  it('refuses a kit whose draft has unpublished changes', async () => {
    reset(start);
    state.draft = [{ ...start[0]!, variations: ['n4'] }];
    posts.length = 0;
    const log: string[] = [];
    expect(
      await applyKit(mkdtempSync(join(tmp, 'site4-')), usage, {
        yes: true,
        ask: async () => false,
        interactive: false,
        version: '1',
        log: (m) => log.push(m),
      }),
    ).toBe(1);
    expect(log[0]).toMatch(/draft has unpublished changes/);
    expect(posts).toEqual([]);
  });

  it("puts the draft back and publishes nothing when Adobe doesn't store what was sent", async () => {
    reset(start);
    state.ignoreVariations = true; // e.g. if the API wanted another list format
    posts.length = 0;
    const root = mkdtempSync(join(tmp, 'site5-'));
    await expect(
      applyKit(root, usage, { yes: true, ask: async () => false, interactive: false, version: '1', log: () => {} }),
    ).rejects.toThrow(/isn't what fontphobia sent.*nothing was published/);
    expect(posts.some((p) => p.publish)).toBe(false);
    expect(state.draft).toEqual(start);
    expect(state.published).toEqual(start);
    expect(readManifest(root)).toBeUndefined();
  });

  it('changes nothing when every style is used', async () => {
    const root = mkdtempSync(join(tmp, 'site2-'));
    const log: string[] = [];
    reset([{ ...start[0]!, variations: ['n4'] }]);
    const u = {
      ...usage,
      faces: { x: { ...usage.faces['inter-400-normal']!, chars: ranges('Hello ‚quoted‘') } },
    } as UsageFileJson;
    expect(
      await applyKit(root, u, { ask: async () => false, interactive: false, version: '1', log: (m) => log.push(m) }),
    ).toBe(0);
    expect(log).toEqual(['kit abc1234: nothing to change']);
  });

  it('revert leaves a kit edited after apply-kit alone, says what to add back, and accepts a kit restored by hand', async () => {
    reset(start);
    const root = mkdtempSync(join(tmp, 'site6-'));
    const o = { yes: true, ask: async () => false, interactive: false, version: '1', log: () => {} };
    expect(await applyKit(root, usage, o)).toBe(0);
    // Someone removes Italic on fonts.adobe.com and publishes.
    state.draft = [{ ...start[0]!, variations: ['n4', 'n7'] }];
    state.published = structuredClone(state.draft);
    posts.length = 0;
    expect(await revertKits(root, () => {})).toEqual([
      'kit abc1234 was edited on fonts.adobe.com after fontphobia published it, so revert leaves it alone. To restore it, add back Inter n3, i4 there and publish, then run revert again; or `fontphobia revert --keep-kits` keeps the kit as it is',
    ]);
    expect(posts).toEqual([]);
    expect(readManifest(root)!.kits).toHaveLength(1);
    // They put the previous styles back themselves: nothing to do, the record goes.
    reset(start);
    const log: string[] = [];
    expect(await revertKits(root, (m) => log.push(m))).toEqual([]);
    expect(log).toEqual(['kit abc1234: already has its previous settings']);
    expect(posts).toEqual([]);
    expect(readManifest(root)?.kits).toBeUndefined();
  });

  it('revert --keep-kits drops the kit record without calling the API', async () => {
    reset(start);
    const root = mkdtempSync(join(tmp, 'site7-'));
    expect(
      await applyKit(root, usage, {
        yes: true,
        ask: async () => false,
        interactive: false,
        version: '1',
        log: () => {},
      }),
    ).toBe(0);
    posts.length = 0;
    const log: string[] = [];
    expect(await revertKits(root, (m) => log.push(m), { keep: true })).toEqual([]);
    expect(log).toEqual(['kit abc1234: left as it is (--keep-kits)']);
    expect(posts).toEqual([]);
    expect(readManifest(root)?.kits).toBeUndefined();
    expect(state.published[0]!.variations).toEqual(['n4', 'n7', 'i4']);
  });
});
