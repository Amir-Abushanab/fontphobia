// adobe-fonts --apply-kit (§6.6) against a stand-in for the Typekit API and Adobe's CDN.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkProject, readManifest, type UsageFileJson } from '@fontphobia/core';
import { applyKit, revertKits } from '../src/apply-kit.ts';

const inter = readFileSync(fileURLToPath(new URL('../../../fixtures/fonts/InterVariable.ttf', import.meta.url)));
const posts: Record<string, string>[] = [];
let kit = { id: 'abc1234', families: [{ id: 'gkmg', name: 'Inter', slug: 'inter', css_names: ['inter'], subset: 'all', variations: ['n3', 'n4', 'n7', 'i4'] }] };
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.headers['x-typekit-token'] !== 'tok' && req.url!.startsWith('/api')) { res.writeHead(401).end('{}'); return; }
      if (req.method === 'GET' && req.url === '/api/kits/abc1234') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kit })); return; }
      if (req.method === 'POST' && req.url === '/api/kits/abc1234') { posts.push(Object.fromEntries(new URLSearchParams(body))); res.writeHead(200).end('{}'); return; }
      if (req.method === 'POST' && req.url === '/api/kits/abc1234/publish') { posts.push({ publish: '1' }); res.writeHead(200).end('{}'); return; }
      if (req.url === '/css/abc1234.css') { res.writeHead(200, { 'content-type': 'text/css' }).end(`@font-face{font-family:"inter";src:url("${base}/af/1/l?fvd=n4") format("woff2");font-weight:400;font-style:normal}`); return; }
      if (req.url!.startsWith('/af/')) { res.writeHead(200).end(inter); return; }
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
afterAll(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); delete process.env.TYPEKIT_TOKEN; delete process.env.TYPEKIT_API; delete process.env.TYPEKIT_CSS; });

const usage = {
  version: 1, meta: { fontphobia: '1', harfbuzz: '1', chrome: '150', framework: 'static', mode: 'static', viewports: [1280], fontSizes: [16] },
  faces: { 'inter-400-normal': { family: 'inter', descriptors: { 'font-weight': '400', 'font-style': 'normal' }, sheet: 'https://use.typekit.net/abc1234.css', source: { adapter: 'adobe-fonts' }, files: [], chars: 'Hello, café', count: 9, inserted: {}, contexts: [], rendered: { weight: [400] }, declared: {}, features: [], locales: ['en'], pages: ['/'] } },
  pages: {},
} as unknown as UsageFileJson;

describe('apply-kit', () => {
  it('removes styles nothing matches, switches to Default, records the previous kit; --check and revert', async () => {
    const root = mkdtempSync(join(tmp, 'site-'));
    writeFileSync(join(root, 'styles.css'), 'body { font-family: inter, serif; }\n');
    const log: string[] = [];
    const o = { ask: async () => false, interactive: false, version: '1', log: (m: string) => log.push(m) };
    // Without --yes and no terminal: shown, not applied.
    expect(await applyKit(root, usage, o)).toBe(1);
    expect(log.join('\n')).toContain('Inter: variations n3,n4,n7,i4 → n4,n7,i4 character set all → default');
    expect(posts).toEqual([]);
    expect(await applyKit(root, usage, { ...o, yes: true })).toBe(0);
    expect(posts).toEqual([{ 'families[0][id]': 'gkmg', 'families[0][variations]': 'n4,n7,i4', 'families[0][subset]': 'default' }, { publish: '1' }]);
    expect(readManifest(root)!.kits).toEqual([{ kit: 'abc1234', previous: [{ id: 'gkmg', variations: ['n3', 'n4', 'n7', 'i4'], subset: 'all' }], applied: [{ id: 'gkmg', variations: ['n4', 'n7', 'i4'], subset: 'default' }] }]);
    // The live kit serves the face and every character.
    expect(await applyKit(root, usage, { ...o, check: true })).toBe(0);
    expect(await applyKit(root, { ...usage, faces: { x: { ...usage.faces['inter-400-normal']!, chars: 'Hello ☃' } } } as UsageFileJson, { ...o, check: true })).toBe(1);
    expect(log.at(-1)).toContain('no longer has ☃');
    posts.length = 0;
    expect(await revertKits(root, () => {})).toEqual([]);
    expect(posts).toEqual([{ 'families[0][id]': 'gkmg', 'families[0][variations]': 'n3,n4,n7,i4', 'families[0][subset]': 'all' }, { publish: '1' }]);
    expect(readManifest(root)?.kits).toBeUndefined();
  });

  it('keeps the character set when the pages draw characters outside Default', async () => {
    const root = mkdtempSync(join(tmp, 'site2-'));
    const log: string[] = [];
    kit = { ...kit, families: [{ ...kit.families[0]!, variations: ['n4'] }] };
    const u = { ...usage, faces: { x: { ...usage.faces['inter-400-normal']!, chars: 'Hello ‚quoted‘' } } } as UsageFileJson;
    expect(await applyKit(root, u, { ask: async () => false, interactive: false, version: '1', log: (m) => log.push(m) })).toBe(0);
    expect(log).toEqual(['kit abc1234: nothing to change']);
  });

  it('check warns about characters outside the Default set once a kit was switched', async () => {
    const root = mkdtempSync(join(tmp, 'site3-'));
    writeFileSync(join(root, 'fontphobia.manifest.json'), JSON.stringify({ version: 1, fontphobia: '1', harfbuzz: '1', chrome: '1', entries: {}, kits: [{ kit: 'abc1234', previous: [{ id: 'gkmg', variations: ['n4'], subset: 'all' }], applied: [{ id: 'gkmg', variations: ['n4'], subset: 'default' }] }] }));
    writeFileSync(join(root, 'index.html'), '<!doctype html><p>Hello ‚quoted‘ and Ünïcödé</p>');
    const r = await checkProject({ root, outputDir: root });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => [i.severity, i.message])).toEqual([['warning', "kit abc1234 now serves Adobe's Default character set; ‚ in the built pages isn't in it: if a kit font draws it, it renders in a fallback font (`fontphobia revert` restores the kit)"]]);
  });
});
