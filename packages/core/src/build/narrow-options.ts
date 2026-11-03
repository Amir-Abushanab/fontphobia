// `next-font-google` (§6.4) and `astro-fonts` (§6.8) in `build`: the options of each `next/font/google`
// call and Astro `fonts[]` entry narrowed in place, fonts still fetched from the provider. Only two
// things change, each provably invisible:
// - weight lists lose weights no weight the site can ask for would match (CSS font matching); the
//   framework downloads, declares and (when preloading) preloads every listed weight;
// - next/font `axes`, with `limit-axes`: tags every use leaves at the default (Google pins an axis
//   left out at its default; spike 5: Inter's latin file 73 KB → 48 KB without `opsz`).
// Styles and subsets stay: the browser italicizes em, i, cite and others on its own, and next/font's
// `subsets` only picks preloads. verify uses the worktree baseline, since "before" is another build.
import { desiredWeights, matchWeight, repoText } from '../adapters/google-url.ts';
import { astroFamily, findAstroFontsEntries } from '../adapters/astro-fonts.ts';
import { findGoogleFontCalls, formatLiteralArray, literalProp, nextGoogleFontData } from '../adapters/next-font.ts';
import { familyKey, parseFamilyList } from '../css/values.ts';
import type { UsageFileJson } from '../plan/planner.ts';
import type { Edit } from './edits.ts';
import type { Manifest, OptionsRecord } from './manifest.ts';

function variationTags(texts: { text: string }[]): Set<string> {
  const out = new Set<string>();
  for (const { text } of texts) for (const m of text.matchAll(/font-?[vV]ariation-?[sS]ettings\s*[:=]\s*([^;}\n]+)/g)) for (const t of m[1]!.matchAll(/["']([a-zA-Z]{4})["']/g)) out.add(t[1]!);
  return out;
}

interface Target { adapter: OptionsRecord['adapter']; file: string; family: string; start: number; end: number; arg: string; weightKey: string; axesKey?: string }

/** Where an option record's call or entry is now: next/font calls and Astro entries, by file. */
export function optionTargets(root: string): Target[] {
  return [
    ...findGoogleFontCalls(root).map((c) => ({ adapter: 'next-font-google' as const, file: c.file, family: c.family, start: c.start, end: c.end, arg: c.arg, weightKey: 'weight', axesKey: 'axes' })),
    ...findAstroFontsEntries(root).map((e) => ({ adapter: 'astro-fonts' as const, file: e.file, family: e.family, start: e.start, end: e.end, arg: e.arg, weightKey: 'weights' })),
  ];
}

export const weightKeyOf = (adapter: OptionsRecord['adapter']) => (adapter === 'astro-fonts' ? 'weights' : 'weight');
export const optionsLabel = (r: Pick<OptionsRecord, 'adapter' | 'family' | 'file'>) => (r.adapter === 'astro-fonts' ? `the ${r.family} fonts[] entry in ${r.file}` : `the ${r.family} next/font/google call in ${r.file}`);

export function narrowOptions(root: string, usage: UsageFileJson, prev: Manifest | undefined, o: { limitAxes: boolean }): { edits: Edit[]; records: OptionsRecord[] } {
  const edits: Edit[] = [];
  const records: OptionsRecord[] = [];
  const targets = optionTargets(root);
  if (!targets.length) return { edits, records: prev?.options ?? [] };
  const texts = repoText(root);
  const tags = variationTags(texts);
  for (const t of targets) {
    const key = familyKey(t.family);
    const faces = Object.values(usage.faces).filter((f) => f.source.adapter === t.adapter && familyKey(astroFamily(parseFamilyList(f.family)[0] ?? f.family)) === key);
    if (!faces.length) continue;
    const reps: { start: number; end: number; text: string }[] = [];
    const dropped: OptionsRecord['dropped'] = { weights: [], axes: [] };
    const w = literalProp(t.arg, t.weightKey);
    if (w?.array && w.values.length > 1 && w.values.every((v) => /^\d+$/.test(v))) {
      const seen = faces.flatMap((f) => [...(f.rendered.weight ?? []), ...(f.declared.weight ?? [])]);
      const want = desiredWeights(texts, seen);
      if (want) {
        const avail = w.values.map(Number);
        const keep = new Set([...want].map((d) => matchWeight(d, avail)!));
        const left = w.values.filter((v) => keep.has(Number(v)));
        if (left.length < w.values.length) {
          reps.push({ start: w.start, end: w.end, text: formatLiteralArray(w, left) });
          dropped.weights = w.values.filter((v) => !keep.has(Number(v))).map(Number);
        }
      }
    }
    const a = o.limitAxes && t.axesKey ? literalProp(t.arg, t.axesKey) : undefined;
    const data = a?.array ? nextGoogleFontData(root, t.family) : undefined;
    if (a?.array && data?.axes) {
      const left = a.values.filter((tag) => {
        const def = data.axes!.find((x) => x.tag === tag)?.defaultValue;
        if (def === undefined || tags.has(tag)) return true;
        const vals = new Set(faces.flatMap((f) => [...(f.rendered.axes?.[tag] ?? []), ...(f.declared.axes?.[tag] ?? [])]));
        return [...vals].some((v) => v !== def);
      });
      if (left.length < a.values.length) {
        dropped.axes = a.values.filter((x) => !left.includes(x));
        if (left.length) reps.push({ start: a.start, end: a.end, text: formatLiteralArray(a, left) });
        else {
          // The whole property goes: `axes: [...]` and the comma after it (a trailing comma is fine).
          const k = t.arg.lastIndexOf(t.axesKey!, a.start);
          const rest = /^\s*,?\s*/.exec(t.arg.slice(a.end))![0];
          reps.push({ start: k, end: a.end + rest.length, text: '' });
        }
      }
    }
    const earlier = prev?.options?.find((r) => r.file === t.file && r.to === t.arg);
    if (!reps.length) { if (earlier) records.push(earlier); continue; }
    let arg = t.arg;
    for (const r of [...reps].sort((x, y) => y.start - x.start)) arg = arg.slice(0, r.start) + r.text + arg.slice(r.end);
    edits.push({ file: t.file, start: t.start, end: t.end, text: arg, why: `narrow ${t.family} (${t.adapter})` });
    records.push({
      adapter: t.adapter, file: t.file, family: t.family, from: earlier?.from ?? t.arg, to: arg,
      dropped: { weights: [...new Set([...(earlier?.dropped.weights ?? []), ...dropped.weights])].sort((x, y) => x - y), axes: [...new Set([...(earlier?.dropped.axes ?? []), ...dropped.axes])].sort() },
    });
  }
  // Earlier narrowings the audit didn't see again stay while their call is unchanged.
  for (const r of prev?.options ?? []) if (!records.some((x) => x.file === r.file && x.from === r.from) && targets.some((c) => c.file === r.file && c.arg === r.to)) records.push(r);
  return { edits, records: records.sort((x, y) => (x.file + x.family < y.file + y.family ? -1 : 1)) };
}
