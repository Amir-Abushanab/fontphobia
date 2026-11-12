// `google-fonts` "tighten" in `build` (§6.5): the stylesheet URLs rewritten in place, fonts still
// served by Google. The manifest keeps the original URL of each (`google`), for revert and verify.
import { createHash } from 'node:crypto';
import { chromeUserAgent, findSheetRefs, isGoogleSheet } from '../adapters/google.ts';
import { desiredWeights, namesFamily, repoText, tightenCss2, type TightenFace } from '../adapters/google-url.ts';
import { familyKey, parseFamilyList } from '../css/values.ts';
import { toSfnt } from '../font/io.ts';
import { parseFvar } from '../font/tables.ts';
import type { UsageFileJson } from '../plan/planner.ts';
import type { Edit } from './edits.ts';
import type { GoogleUrlRecord, Manifest } from './manifest.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const amp = (u: string) => u.replace(/&/g, '&amp;');

type Usage = UsageFileJson & {
  unloaded?: Record<string, { family: string; descriptors: Record<string, string>; sheet?: string }>;
};

/** Axis tags the code sets with font-variation-settings, by family key (`*`: any family). */
function variationTags(texts: { text: string }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>([['*', new Set()]]);
  for (const { text } of texts) {
    for (const m of text.matchAll(/font-?[vV]ariation-?[sS]ettings\s*[:=]\s*([^;}\n]+)/g)) {
      for (const t of m[1]!.matchAll(/["']([a-zA-Z]{4})["']/g)) out.get('*')!.add(t[1]!);
    }
  }
  return out;
}

async function axisDefaults(usage: Usage, sheet: string): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  for (const f of Object.values(usage.faces)) {
    if (f.sheet !== sheet || out.has(familyKey(parseFamilyList(f.family)[0] ?? f.family))) continue;
    const file = f.files[0];
    if (!file?.sha256) continue;
    const url = file.url.startsWith('http')
      ? file.url
      : `https://fonts.gstatic.com${file.url.startsWith('/') ? '' : '/'}${file.url}`;
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': chromeUserAgent(usage.meta.chrome) },
        signal: AbortSignal.timeout(30_000),
      });
      const b = new Uint8Array(await r.arrayBuffer());
      if (!r.ok || sha(b) !== file.sha256) continue; // Google serves something else now: keep every axis
      const fvar = parseFvar(await toSfnt(b));
      if (fvar)
        out.set(
          familyKey(parseFamilyList(f.family)[0] ?? f.family),
          Object.fromEntries(fvar.axes.map((a) => [a.tag, a.default])),
        );
    } catch {
      /* offline: keep every axis */
    }
  }
  return out;
}

/** What `--allow tighten` would drop from a Google URL, for the report. `cssBytes`: Google CSS rules it saves (font downloads don't change). */
export interface TightenSuggestion {
  sheet: string;
  families: string[];
  weights: Record<string, number[]>;
  cssBytes: number;
}

/**
 * `drop` (the `tighten` opt-in): families and static weights nothing uses. Off by default: it saves
 * only Google's CSS (browsers never download unused faces), and a page the audit never saw, or text
 * from a CMS, could ask for one. Then it's measured and reported instead. `limitAxes`: default-only axes.
 */
export async function tightenGoogle(
  root: string,
  usage: Usage,
  prev: Manifest | undefined,
  o: { limitAxes: boolean; drop: boolean },
): Promise<{ edits: Edit[]; records: GoogleUrlRecord[]; suggestions: TightenSuggestion[] }> {
  const sheets = [
    ...new Set(
      [...Object.values(usage.faces), ...Object.values(usage.unloaded ?? {})].map((f) => f.sheet).filter(isGoogleSheet),
    ),
  ].toSorted();
  const edits: Edit[] = [];
  const records: GoogleUrlRecord[] = [];
  const suggestions: TightenSuggestion[] = [];
  const done = new Set<string>();
  let texts: ReturnType<typeof repoText> | undefined;
  for (const sheet of sheets) {
    texts ??= repoText(root);
    const faces = Object.values(usage.faces).filter((f) => f.sheet === sheet);
    const loaded: TightenFace[] = faces.map((f) => ({
      family: parseFamilyList(f.family)[0] ?? f.family,
      rendered: Object.fromEntries(
        [...new Set([...Object.keys(f.rendered.axes ?? {}), ...Object.keys(f.declared.axes ?? {})])].map((t) => [
          t,
          [...(f.rendered.axes?.[t] ?? []), ...(f.declared.axes?.[t] ?? [])],
        ]),
      ),
    }));
    const seen = faces.flatMap((f) => [...(f.rendered.weight ?? []), ...(f.declared.weight ?? [])]);
    const full = {
      sheet,
      loaded,
      named: (fam: string) => namesFamily(texts!, fam),
      weights: desiredWeights(texts, seen),
      variationTags: variationTags(texts),
    };
    if (!o.drop) {
      const would = tightenCss2(full);
      if (would && (would.families.length || Object.keys(would.weights).length)) {
        const rules = Object.values(usage.unloaded ?? {}).filter(
          (f) =>
            f.sheet === sheet &&
            (would.families.some((x) => familyKey(x) === familyKey(parseFamilyList(f.family)[0] ?? f.family)) ||
              (would.weights[parseFamilyList(f.family)[0] ?? f.family] ?? []).includes(
                Number(f.descriptors['font-weight']),
              )),
        );
        const cssBytes = rules.reduce(
          (n, f) => n + Object.entries(f.descriptors).reduce((m, [k, v]) => m + k.length + v.length + 5, 14),
          0,
        );
        suggestions.push({ sheet, families: would.families, weights: would.weights, cssBytes });
      }
    }
    const t = tightenCss2({
      ...full,
      ...(o.drop ? {} : { named: () => ['(kept: tighten not allowed)'], weights: undefined }),
      axisDefaults: o.limitAxes ? await axisDefaults(usage, sheet) : undefined,
    });
    const earlier = prev?.google?.find((r) => r.to === sheet);
    if (!t) {
      if (earlier) {
        records.push(earlier);
        done.add(earlier.to);
      }
      continue;
    }
    const refs = findSheetRefs(root, sheet);
    if (!refs.length) continue;
    for (const r of refs)
      edits.push({
        file: r.file,
        start: r.start,
        end: r.end,
        text: r.text.includes('&amp;') ? amp(t.url) : t.url,
        why: `tighten ${sheet}`,
      });
    const merge = <T>(a: Record<string, T[]> = {}, b: Record<string, T[]>) =>
      Object.fromEntries(
        [...new Set([...Object.keys(a), ...Object.keys(b)])]
          .toSorted()
          .map((k) => [k, [...new Set([...(a[k] ?? []), ...(b[k] ?? [])])].toSorted()]),
      );
    records.push({
      from: earlier?.from ?? sheet,
      to: t.url,
      files: [...new Set(refs.map((r) => r.file))].toSorted(),
      dropped: {
        families: [...new Set([...(earlier?.dropped.families ?? []), ...t.families])].toSorted(),
        weights: merge(earlier?.dropped.weights, t.weights),
        axes: merge(earlier?.dropped.axes, t.axes),
      },
    });
    if (earlier) done.add(earlier.to);
  }
  // Earlier rewrites the audit didn't see again stay while their URL is still in the repo.
  for (const r of prev?.google ?? [])
    if (!done.has(r.to) && !records.some((x) => x.to === r.to) && findSheetRefs(root, r.to).length) records.push(r);
  return { edits, records: records.toSorted((a, b) => (a.from < b.from ? -1 : 1)), suggestions };
}
