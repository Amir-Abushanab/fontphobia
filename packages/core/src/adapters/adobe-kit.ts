// `adobe-fonts --apply-kit` (§6.6): kit styles (FVD variations) no weight the site can ask for would
// match are removed through the Typekit API v1 (CSS font matching per style, as for Google's URL).
// Opt-in, token-authenticated, confirmed first (other sites may share the kit). Tested on a real kit
// (2026-11-04): the draft read back exactly as sent, the CDN served the change, revert restored it.
// The character set isn't changed (see planKit).
// The previous families go in the manifest; revert puts them back. Fonts are never written to disk.
// Every write is read back before anything is published.
import { matchWeight } from './google-url.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import { loadFont } from '../font/hb.ts';
import { toSfnt } from '../font/io.ts';

export const TYPEKIT_API = 'https://typekit.com/api/v1/json';

export interface KitFamily { id: string; name?: string; slug?: string; css_names?: string[]; subset: string; variations: string[] }
export interface KitChange { id: string; name: string; variations: [string[], string[]]; why: string[] }
export interface KitPlan { kit: string; families: KitFamily[]; changes: KitChange[] }

export interface KitUsageFace { family: string; descriptors: Record<string, string>; chars: string; rendered: { weight?: number[] }; declared: { weight?: number[] } }

const fvdWeight = (v: string) => Number(v.slice(1)) * 100;

/** What to change in one kit, from the faces the audit saw drawing from it and the weights the code can ask for. */
export function planKit(kit: string, families: KitFamily[], faces: KitUsageFace[], desired: Set<number> | undefined): KitPlan {
  const changes: KitChange[] = [];
  for (const f of families) {
    const names = new Set([...(f.css_names ?? []), f.slug ?? '', f.name ?? ''].filter(Boolean).map((x) => x.toLowerCase()));
    const mine = faces.filter((x) => names.has(x.family.replace(/^["']|["']$/g, '').toLowerCase()));
    if (!mine.length) continue; // no page draws with it: left alone (removing a family is the user's call)
    const why: string[] = [];
    let variations = f.variations;
    if (desired) {
      const want = new Set([...desired, ...mine.flatMap((x) => [...(x.rendered.weight ?? []), ...(x.declared.weight ?? [])])]);
      const keep = new Set<string>();
      for (const style of new Set(f.variations.map((v) => v[0]!))) {
        const group = f.variations.filter((v) => v[0] === style);
        for (const d of want) { const w = matchWeight(d, group.map(fvdWeight)); if (w !== undefined) keep.add(`${style}${w / 100}`); }
      }
      const left = f.variations.filter((v) => keep.has(v));
      if (left.length < f.variations.length) { why.push(`no weight the site asks for matches ${f.variations.filter((v) => !keep.has(v)).join(', ')}`); variations = left; }
    }
    // The character set isn't changed: the API's `subset` doesn't follow the web UI's "Character set"
    // (a kit set to All Characters in the UI still reads "default", 2026-11-04), so the report says
    // which setting to pick and you change it on fonts.adobe.com. Each family's subset is sent back as read.
    if (why.length) changes.push({ id: f.id, name: f.name ?? f.slug ?? f.id, variations: [f.variations, variations], why });
  }
  return { kit, families, changes };
}

/** The kit's families as they'd be sent after the plan: the API replaces `families` whole. */
export function plannedFamilies(p: KitPlan): { id: string; variations: string[]; subset: string }[] {
  return p.families.map((f) => { const c = p.changes.find((x) => x.id === f.id); return { id: f.id, variations: c ? c.variations[1] : f.variations, subset: f.subset }; });
}

export interface KitApi { token: string; base?: string; fetch?: typeof fetch }

async function call(api: KitApi, method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<unknown> {
  const r = await (api.fetch ?? fetch)(`${api.base ?? TYPEKIT_API}${path}`, { method, headers: { 'X-Typekit-Token': api.token, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Typekit API ${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const normFamilies = (r: { kit?: { families?: KitFamily[] } }, kit: string): KitFamily[] => {
  if (!r.kit?.families) throw new Error(`Typekit API: kit ${kit} has no families`);
  return r.kit.families.map((f) => ({ ...f, variations: Array.isArray(f.variations) ? f.variations : String(f.variations).split(',').filter(Boolean) }));
};

/** The kit's draft families (`GET /kits/:kit`). */
export async function getKit(api: KitApi, kit: string): Promise<KitFamily[]> {
  return normFamilies((await call(api, 'GET', `/kits/${encodeURIComponent(kit)}`)) as { kit?: { families?: KitFamily[] } }, kit);
}

/** The kit's published families (`GET /kits/:kit/published`). */
export async function getPublishedKit(api: KitApi, kit: string): Promise<KitFamily[]> {
  return normFamilies((await call(api, 'GET', `/kits/${encodeURIComponent(kit)}/published`)) as { kit?: { families?: KitFamily[] } }, kit);
}

type FamilySetting = { id: string; variations: string[]; subset: string };
const key = (fs: FamilySetting[]) => JSON.stringify([...fs].map((f) => [f.id, [...f.variations].sort(), f.subset]).sort());
export const sameFamilies = (a: FamilySetting[], b: FamilySetting[]) => key(a) === key(b);

async function postFamilies(api: KitApi, kit: string, families: FamilySetting[]): Promise<void> {
  const body = new URLSearchParams();
  families.forEach((f, i) => { body.set(`families[${i}][id]`, f.id); body.set(`families[${i}][variations]`, f.variations.join(',')); body.set(`families[${i}][subset]`, f.subset); });
  await call(api, 'POST', `/kits/${encodeURIComponent(kit)}`, body);
}

/**
 * Replace the draft's families (all of them: the API replaces the list), read the draft back, and
 * publish only if it's exactly what was sent. Otherwise the previous draft is restored and nothing
 * is published. `expectDraft`: the draft must still be this (no edits made in the meantime).
 */
export async function setKitFamilies(api: KitApi, kit: string, families: FamilySetting[], o: { expectDraft?: FamilySetting[] } = {}): Promise<void> {
  const before = await getKit(api, kit);
  if (o.expectDraft && !sameFamilies(before, o.expectDraft)) throw new Error(`kit ${kit} changed since it was read; nothing was changed. Run apply-kit again`);
  await postFamilies(api, kit, families);
  const after = await getKit(api, kit);
  if (!sameFamilies(after, families)) {
    await postFamilies(api, kit, before.map((f) => ({ id: f.id, variations: f.variations, subset: f.subset }))).catch(() => {});
    throw new Error(`kit ${kit}: the draft Adobe stored isn't what fontphobia sent (sent ${key(families)}, stored ${key(after)}); the previous draft was put back and nothing was published`);
  }
  await call(api, 'POST', `/kits/${encodeURIComponent(kit)}/publish`);
}

export const kitIdOf = (sheet: string) => /use\.typekit\.net\/([a-z0-9]+)\.css/i.exec(sheet)?.[1];

/**
 * After publishing (Adobe's CDN can take minutes): does the live kit still serve every face the pages
 * use, with every character they draw? The kit's CSS and fonts are fetched and read in memory only.
 */
export async function checkLiveKit(kit: string, faces: KitUsageFace[], o: { fetch?: typeof fetch; cssBase?: string } = {}): Promise<string[]> {
  const f = o.fetch ?? fetch;
  const css = await (await f(`${o.cssBase ?? 'https://use.typekit.net'}/${kit}.css`, { signal: AbortSignal.timeout(30_000) })).text();
  const rules = parseStylesheet(css).fontFaces;
  const problems: string[] = [];
  for (const face of faces) {
    const fam = face.family.replace(/^["']|["']$/g, '').toLowerCase();
    const want = `${(face.descriptors['font-style'] ?? 'normal').trim()}|${(face.descriptors['font-weight'] ?? '400').trim()}`;
    const r = rules.find((x) => x.family.toLowerCase() === fam && `${(x.descriptors['font-style'] ?? 'normal').trim()}|${(x.descriptors['font-weight'] ?? '400').trim()}` === want);
    const url = r?.src.find((s) => s.url && /woff2/.test(s.format ?? ''))?.url ?? r?.src.find((s) => s.url)?.url;
    if (!url) { problems.push(`${fam} ${want.replace('|', ' ')} is no longer in kit ${kit}`); continue; }
    const bytes = new Uint8Array(await (await f(url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer());
    const cmap = new Set(loadFont(await toSfnt(bytes)).face.collectUnicodes());
    const missing = [...face.chars].filter((ch) => !cmap.has(ch.codePointAt(0)!));
    if (missing.length) problems.push(`${fam} ${want.replace('|', ' ')} in kit ${kit} no longer has ${missing.slice(0, 12).join(' ')}`);
  }
  return problems;
}
