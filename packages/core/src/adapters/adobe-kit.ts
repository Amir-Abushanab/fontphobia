// `adobe-fonts --apply-kit` (§6.6): the two kit settings the Typekit API v1 can change, applied to
// the user's kit. Opt-in, token-authenticated, confirmed first (other sites may share the kit):
// - variations (FVD codes) no weight the site can ask for would match are removed (CSS font
//   matching per style, as for Google's URL);
// - `subset: "all"` becomes `"default"` when every character the kit's faces draw is in Adobe's
//   Default set (EN/FR/DE/IT/PT/ES).
// The previous families go in the manifest; revert puts them back. Fonts are never written to disk.
import { matchWeight } from './google-url.ts';
import { parseStylesheet } from '../css/stylesheet.ts';
import { loadFont } from '../font/hb.ts';
import { toSfnt } from '../font/io.ts';

/**
 * Adobe's Default character set, read from the cmap of Default-set kit files (kits eny7olf and ezf4sbn,
 * 2026-11-03; the code points both have, private use aside). Note what's missing: ‚ † ‡ ‰ ˆ ƒ.
 */
const DEFAULT_EXTRA = new Set([0x152, 0x153, 0x178, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026, 0x2039, 0x203a, 0x20ac, 0x2122]);
export const inAdobeDefault = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || DEFAULT_EXTRA.has(cp);

export const TYPEKIT_API = 'https://typekit.com/api/v1/json';

export interface KitFamily { id: string; name?: string; slug?: string; css_names?: string[]; subset: string; variations: string[] }
export interface KitChange { id: string; name: string; variations: [string[], string[]]; subset: [string, string]; why: string[] }
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
    let subset = f.subset;
    if (f.subset === 'all') {
      const outside = new Set<string>();
      for (const x of mine) for (const ch of x.chars) if (!inAdobeDefault(ch.codePointAt(0)!)) outside.add(ch);
      if (!outside.size) { subset = 'default'; why.push('every character the pages draw with it is in the Default set (EN, FR, DE, IT, PT, ES)'); }
    }
    if (why.length) changes.push({ id: f.id, name: f.name ?? f.slug ?? f.id, variations: [f.variations, variations], subset: [f.subset, subset], why });
  }
  return { kit, families, changes };
}

/** The kit's families as they'd be sent after the plan: the API replaces `families` whole. */
export function plannedFamilies(p: KitPlan): { id: string; variations: string[]; subset: string }[] {
  return p.families.map((f) => { const c = p.changes.find((x) => x.id === f.id); return { id: f.id, variations: c ? c.variations[1] : f.variations, subset: c ? c.subset[1] : f.subset }; });
}

export interface KitApi { token: string; base?: string; fetch?: typeof fetch }

async function call(api: KitApi, method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<unknown> {
  const r = await (api.fetch ?? fetch)(`${api.base ?? TYPEKIT_API}${path}`, { method, headers: { 'X-Typekit-Token': api.token, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Typekit API ${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** The kit's draft families. */
export async function getKit(api: KitApi, kit: string): Promise<KitFamily[]> {
  const r = (await call(api, 'GET', `/kits/${encodeURIComponent(kit)}`)) as { kit?: { families?: KitFamily[] } };
  if (!r.kit?.families) throw new Error(`Typekit API: kit ${kit} has no families`);
  return r.kit.families.map((f) => ({ ...f, variations: Array.isArray(f.variations) ? f.variations : String(f.variations).split(',').filter(Boolean) }));
}

/** Replace the draft's families (all of them: the API replaces the list) and publish. */
export async function setKitFamilies(api: KitApi, kit: string, families: { id: string; variations: string[]; subset: string }[]): Promise<void> {
  const body = new URLSearchParams();
  families.forEach((f, i) => { body.set(`families[${i}][id]`, f.id); body.set(`families[${i}][variations]`, f.variations.join(',')); body.set(`families[${i}][subset]`, f.subset); });
  await call(api, 'POST', `/kits/${encodeURIComponent(kit)}`, body);
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
