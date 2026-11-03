// `next-font-google` in `build` (§6.4): the options of each `next/font/google` call narrowed in place,
// fonts still fetched from Google by Next. Only two things change, each provably invisible:
// - `weight` arrays lose weights no weight the site can ask for would match (CSS font matching);
//   for a static family every listed weight is downloaded and its subsets preloaded;
// - with `limit-axes`, `axes` loses tags every use leaves at the default (Google pins an axis
//   left out at its default; spike 5: Inter's latin file 73 KB → 48 KB without `opsz`).
// `style` and `subsets` stay: the browser italicizes em/i on its own, and `subsets` only picks
// preloads. verify uses the worktree baseline, since "before" is a different Next build.
import { desiredWeights, matchWeight, repoText } from '../adapters/google-url.ts';
import { findGoogleFontCalls, literalProp, nextGoogleFontData } from '../adapters/next-font.ts';
import { familyKey, parseFamilyList } from '../css/values.ts';
import type { UsageFileJson } from '../plan/planner.ts';
import type { Edit } from './edits.ts';
import type { Manifest, NextGoogleRecord } from './manifest.ts';

function variationTags(texts: { text: string }[]): Set<string> {
  const out = new Set<string>();
  for (const { text } of texts) for (const m of text.matchAll(/font-?[vV]ariation-?[sS]ettings\s*[:=]\s*([^;}\n]+)/g)) for (const t of m[1]!.matchAll(/["']([a-zA-Z]{4})["']/g)) out.add(t[1]!);
  return out;
}

export function narrowNextGoogle(root: string, usage: UsageFileJson, prev: Manifest | undefined, o: { limitAxes: boolean }): { edits: Edit[]; records: NextGoogleRecord[] } {
  const edits: Edit[] = [];
  const records: NextGoogleRecord[] = [];
  const calls = findGoogleFontCalls(root);
  if (!calls.length) return { edits, records: prev?.nextGoogle ?? [] };
  const texts = repoText(root);
  const tags = variationTags(texts);
  for (const call of calls) {
    const key = familyKey(call.family);
    const faces = Object.values(usage.faces).filter((f) => f.source.adapter === 'next-font-google' && familyKey(parseFamilyList(f.family)[0] ?? f.family) === key);
    if (!faces.length) continue;
    const reps: { start: number; end: number; text: string }[] = [];
    const dropped: NextGoogleRecord['dropped'] = { weights: [], axes: [] };
    const w = literalProp(call.arg, 'weight');
    if (w?.array && w.values.length > 1 && w.values.every((v) => /^\d+$/.test(v))) {
      const seen = faces.flatMap((f) => [...(f.rendered.weight ?? []), ...(f.declared.weight ?? [])]);
      const want = desiredWeights(texts, seen);
      if (want) {
        const avail = w.values.map(Number);
        const keep = new Set([...want].map((d) => matchWeight(d, avail)!));
        const left = w.values.filter((v) => keep.has(Number(v)));
        if (left.length < w.values.length) {
          reps.push({ start: w.start, end: w.end, text: `[${left.map((v) => `${w.quote}${v}${w.quote}`).join(', ')}]` });
          dropped.weights = w.values.filter((v) => !keep.has(Number(v))).map(Number);
        }
      }
    }
    const a = o.limitAxes ? literalProp(call.arg, 'axes') : undefined;
    const data = a?.array ? nextGoogleFontData(root, call.family) : undefined;
    if (a?.array && data?.axes) {
      const left = a.values.filter((tag) => {
        const def = data.axes!.find((x) => x.tag === tag)?.defaultValue;
        if (def === undefined || tags.has(tag)) return true;
        const vals = new Set(faces.flatMap((f) => [...(f.rendered.axes?.[tag] ?? []), ...(f.declared.axes?.[tag] ?? [])]));
        return [...vals].some((v) => v !== def);
      });
      if (left.length < a.values.length) {
        dropped.axes = a.values.filter((t) => !left.includes(t));
        if (left.length) reps.push({ start: a.start, end: a.end, text: `[${left.map((v) => `${a.quote}${v}${a.quote}`).join(', ')}]` });
        else {
          // The whole property goes: `axes: [...]` and the comma after it (a trailing comma is fine).
          const k = call.arg.lastIndexOf('axes', a.start);
          const rest = /^\s*,?\s*/.exec(call.arg.slice(a.end))![0];
          reps.push({ start: k, end: a.end + rest.length, text: '' });
        }
      }
    }
    const earlier = prev?.nextGoogle?.find((r) => r.file === call.file && r.to === call.arg);
    if (!reps.length) { if (earlier) records.push(earlier); continue; }
    let arg = call.arg;
    for (const r of [...reps].sort((x, y) => y.start - x.start)) arg = arg.slice(0, r.start) + r.text + arg.slice(r.end);
    edits.push({ file: call.file, start: call.start, end: call.end, text: arg, why: `narrow ${call.family} (next/font/google)` });
    records.push({
      file: call.file, family: call.family, from: earlier?.from ?? call.arg, to: arg,
      dropped: { weights: [...new Set([...(earlier?.dropped.weights ?? []), ...dropped.weights])].sort((x, y) => x - y), axes: [...new Set([...(earlier?.dropped.axes ?? []), ...dropped.axes])].sort() },
    });
  }
  // Earlier narrowings the audit didn't see again stay while their call is unchanged.
  for (const r of prev?.nextGoogle ?? []) if (!records.some((x) => x.file === r.file && x.from === r.from) && calls.some((c) => c.file === r.file && c.arg === r.to)) records.push(r);
  return { edits, records: records.sort((x, y) => (x.file + x.family < y.file + y.family ? -1 : 1)) };
}
