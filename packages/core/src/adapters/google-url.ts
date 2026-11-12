// `google-fonts` "tighten" (§6.5): the stylesheet URL rewritten so Google serves less, while every
// page renders as before. Only the css2 API (`/css2?family=…`); legacy `/css?family=` URLs and
// `text=` URLs are left alone. What it drops, and why that can't change rendering:
// - a family no page loaded and nothing in the repo names (outside Google URLs);
// - a static weight no weight the site can ask for would match (CSS font matching, per style);
// - with `limit-axes`, an axis every use resolves to its default (Google pins an omitted axis
//   there, spike 6), and only one the served file varies.
// Ranges are never narrowed (spike 6: same bytes normally, a differently-rendering file sometimes),
// and `ital` tuples always stay (the browser's own styles italicize em, i, cite, …).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { familyKey, relativeWeight } from '../css/values.ts';
import { listFiles } from '../project/detect.ts';

export interface Css2Family {
  /** As written in the URL (`Open+Sans:ital,wght@0,400;1,700`). */
  raw: string;
  name: string;
  axes: string[];
  /** One value string per axis (`400`, `100..900`). */
  tuples: string[][];
}

export interface Css2Url {
  url: string;
  families: Css2Family[];
}

/** The css2 families of a Google stylesheet URL; undefined for anything this can't rewrite safely. */
export function parseCss2(sheet: string): Css2Url | undefined {
  const q = sheet.indexOf('?');
  if (q < 0 || !/^https?:\/\/fonts\.googleapis\.com\/css2$/i.test(sheet.slice(0, q))) return undefined;
  const families: Css2Family[] = [];
  for (const part of sheet.slice(q + 1).split('&')) {
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    if (k === 'text') return undefined;
    if (k !== 'family') continue;
    const raw = part.slice(eq + 1);
    const colon = raw.indexOf(':');
    let name: string;
    try {
      name = decodeURIComponent((colon < 0 ? raw : raw.slice(0, colon)).replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
    if (colon < 0) {
      families.push({ raw, name, axes: [], tuples: [] });
      continue;
    }
    const spec = decodeURIComponent(raw.slice(colon + 1));
    const at = spec.indexOf('@');
    if (at < 0) return undefined;
    const axes = spec.slice(0, at).split(',');
    const tuples = spec
      .slice(at + 1)
      .split(';')
      .map((t) => t.split(','));
    if (
      !axes.every((a) => /^[a-zA-Z]{4}$/.test(a)) ||
      !tuples.every((t) => t.length === axes.length && t.every((v) => /^-?\d+(\.\d+)?(\.\.-?\d+(\.\d+)?)?$/.test(v)))
    )
      return undefined;
    families.push({ raw, name, axes, tuples });
  }
  return families.length ? { url: sheet, families } : undefined;
}

const first = (v: string) => Number(v.split('..')[0]);
/** Google wants tuples sorted (axis by axis, by their first value). */
function sortTuples(t: string[][]): string[][] {
  return [...new Map(t.map((x) => [x.join(','), x])).values()].toSorted((a, b) => {
    for (let i = 0; i < a.length; i++) {
      const d = first(a[i]!) - first(b[i]!);
      if (d) return d;
    }
    return 0;
  });
}

export function formatFamily(f: Css2Family, nameRaw: string): string {
  return f.axes.length
    ? `${nameRaw}:${f.axes.join(',')}@${sortTuples(f.tuples)
        .map((t) => t.join(','))
        .join(';')}`
    : nameRaw;
}

/** CSS font matching for weights (CSS Fonts 4 §5.2) among static weights. */
export function matchWeight(d: number, avail: number[]): number | undefined {
  if (avail.includes(d)) return d;
  const up = avail.filter((w) => w > d).toSorted((a, b) => a - b),
    down = avail.filter((w) => w < d).toSorted((a, b) => b - a);
  if (d >= 400 && d <= 500) return up.find((w) => w <= 500) ?? down[0] ?? up[0];
  return d < 400 ? (down[0] ?? up[0]) : (up[0] ?? down[0]);
}

const CODE = /\.(html?|astro|vue|svelte|m?[jt]sx?|cjs|mdx?|css|scss|less|pcss|json|ya?ml|toml)$/i;
const SKIP = new Set([
  'node_modules',
  '.git',
  '.fontphobia',
  'dist',
  'build',
  'out',
  '_site',
  '.output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.vercel',
  '.netlify',
  '.turbo',
  '.cache',
  'coverage',
  '.angular',
  '.wrangler',
  '.docusaurus',
  '.tanstack',
  '.nitro',
  'public',
]);
const GOOGLE_URL = /https?:\/\/fonts\.googleapis\.com\/[^\s"'`)<>]*/gi;

/** The repo's code and style text, Google stylesheet URLs blanked out. */
export function repoText(root: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const file of listFiles(
    root,
    (r) => CODE.test(r) && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|fontphobia\.manifest\.json)$/.test(r),
    { skip: (_rel, n) => SKIP.has(n) || n.startsWith('.') },
  )) {
    try {
      if (statSync(join(root, file)).size > 1_000_000) continue;
      out.push({ file, text: readFileSync(join(root, file), 'utf8').replace(GOOGLE_URL, '') });
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** Files that name the family (word-bounded, any case). */
export function namesFamily(texts: { file: string; text: string }[], family: string): string[] {
  const re = new RegExp(
    `(^|[^\\w-])${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ +_-]?')}($|[^\\w-])`,
    'i',
  );
  return texts.filter((t) => re.test(t.text)).map((t) => t.file);
}

const TW: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

/**
 * Every weight the site's code can ask for, closed under `bolder` (b, strong) and, when used,
 * `lighter`; 400 and 700 are always in (body text, headings). Undefined when a weight is computed
 * (`var()`, `calc()`, a JS expression): then no weight is dropped.
 */
export function desiredWeights(texts: { text: string }[], seen: number[] = []): Set<number> | undefined {
  const d = new Set<number>([400, 700, ...seen]);
  let lighter = false;
  const add = (v: string): boolean => {
    v = v
      .trim()
      .replace(/^["'{(\s]+|["'})\s]+$/g, '')
      .replace(/\s*!important$/, '')
      .toLowerCase();
    if (/^\d+(\.\d+)?$/.test(v)) {
      d.add(Number(v));
      return true;
    }
    if (v === 'normal') {
      d.add(400);
      return true;
    }
    if (v === 'bold') {
      d.add(700);
      return true;
    }
    if (v === 'bolder') return true;
    if (v === 'lighter') {
      lighter = true;
      return true;
    }
    return ['inherit', 'initial', 'unset', 'revert', 'revert-layer', ''].includes(v);
  };
  for (const { text: raw } of texts) {
    const text = raw.replace(/@font-face\s*\{[^}]*\}/gi, ''); // descriptors (`font-weight: 100 900`) aren't requests
    for (const m of text.matchAll(/font-weight\s*:\s*([^;}\n"'`]+)/gi)) if (!add(m[1]!)) return undefined;
    for (const m of text.matchAll(/\bfontWeight\s*[:=]\s*([^,;}\n]+)/g)) if (!add(m[1]!)) return undefined;
    for (const m of text.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}\n]+)/g))
      for (const t of m[1]!.split(/\s+/)) {
        if (/^[1-9]\d\d$/.test(t) || t === 'bold' || t === 'bolder' || t === 'lighter') add(t);
        if (t.startsWith('var(')) return undefined;
      }
    for (const m of text.matchAll(/["']wght["']\s+(\d+(?:\.\d+)?)/g)) d.add(Number(m[1]));
    for (const m of text.matchAll(
      /(?:^|[\s"'`:])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?=$|[\s"'`])/g,
    ))
      d.add(TW[m[1]!]!);
    for (const m of text.matchAll(/\bfont-\[(\d+)\]/g)) d.add(Number(m[1]));
  }
  for (let size = 0; size !== d.size;) {
    size = d.size;
    // eslint-disable-next-line no-useless-spread -- a snapshot: the loop adds to the set
    for (const w of [...d]) {
      d.add(relativeWeight('bolder', w));
      if (lighter) d.add(relativeWeight('lighter', w));
    }
  }
  return d;
}

export interface TightenFace {
  family: string;
  /** Axis values rendered and declared. */ rendered: Record<string, number[]>;
}

export interface TightenInput {
  sheet: string;
  /** Faces of this sheet some page loaded, with the axis values they rendered and declared. */
  loaded: TightenFace[];
  /** Files that name each family outside Google URLs. */
  named: (family: string) => string[];
  /** desiredWeights(); undefined keeps every weight. */
  weights: Set<number> | undefined;
  /** limit-axes: each family's axis defaults from the file Google served (fvar). */
  axisDefaults?: Map<string, Record<string, number>>;
  /** Axes the CSS sets by font-variation-settings, by family key (`*` = any family). */
  variationTags?: Map<string, Set<string>>;
}

export interface Tightened {
  url: string;
  families: string[];
  weights: Record<string, number[]>;
  axes: Record<string, string[]>;
}

export function tightenCss2(o: TightenInput): Tightened | undefined {
  const p = parseCss2(o.sheet);
  if (!p) return undefined;
  const out: Tightened = { url: o.sheet, families: [], weights: {}, axes: {} };
  const parts = o.sheet.slice(o.sheet.indexOf('?') + 1).split('&');
  const next: string[] = [];
  let fi = 0;
  for (const part of parts) {
    if (!part.startsWith('family=')) {
      next.push(part);
      continue;
    }
    const f = p.families[fi++]!;
    const key = familyKey(f.name);
    const loaded = o.loaded.filter((x) => familyKey(x.family) === key);
    if (!loaded.length && !o.named(f.name).length) {
      out.families.push(f.name);
      continue;
    }
    const nameRaw = f.raw.includes(':') ? f.raw.slice(0, f.raw.indexOf(':')) : f.raw;
    let g: Css2Family = { ...f, axes: [...f.axes], tuples: f.tuples.map((t) => [...t]) };
    // Axes every use leaves at the default (limit-axes).
    const defaults = o.axisDefaults?.get(key);
    if (defaults && loaded.length) {
      for (const tag of g.axes) {
        if (tag === 'wght' || tag === 'ital' || defaults[tag] === undefined) continue;
        const i = g.axes.indexOf(tag);
        if (!g.tuples.every((t) => t[i]!.includes('..'))) continue; // a pinned value isn't the default
        if (o.variationTags?.get(key)?.has(tag) || o.variationTags?.get('*')?.has(tag)) continue;
        const vals = new Set(loaded.flatMap((x) => x.rendered[tag] ?? []));
        if ([...vals].some((v) => v !== defaults[tag])) continue;
        g = { ...g, axes: g.axes.filter((_, j) => j !== i), tuples: g.tuples.map((t) => t.filter((_, j) => j !== i)) };
        (out.axes[f.name] ??= []).push(tag);
      }
    }
    // Static weights nothing would match, per style.
    const wi = g.axes.indexOf('wght');
    if (o.weights && wi >= 0 && g.tuples.every((t) => !t[wi]!.includes('..'))) {
      const ii = g.axes.indexOf('ital');
      const styleOf = (t: string[]) => (ii >= 0 ? t[ii]! : '0');
      const keep = new Set<string>();
      for (const s of new Set(g.tuples.map(styleOf))) {
        const group = g.tuples.filter((t) => styleOf(t) === s);
        const avail = group.map((t) => Number(t[wi]));
        for (const d of o.weights) {
          const w = matchWeight(d, avail);
          if (w !== undefined) keep.add(`${s}|${w}`);
        }
      }
      const dropped = g.tuples.filter((t) => !keep.has(`${styleOf(t)}|${Number(t[wi])}`));
      if (dropped.length) {
        g = { ...g, tuples: g.tuples.filter((t) => keep.has(`${styleOf(t)}|${Number(t[wi])}`)) };
        out.weights[f.name] = [...new Set(dropped.map((t) => Number(t[wi])))].toSorted((a, b) => a - b);
      }
    }
    next.push(
      `family=${g.axes.length === f.axes.length && g.tuples.length === f.tuples.length ? f.raw : formatFamily(g, nameRaw)}`,
    );
  }
  if (!next.some((x) => x.startsWith('family='))) return undefined; // every family unused: leave the link for a person to remove
  out.url = `${o.sheet.slice(0, o.sheet.indexOf('?'))}?${next.join('&')}`;
  return out.url === o.sheet ? undefined : out;
}

/** Weights dropped from `from` for `family` that a desired weight would match now (per style). */
export function neededWeights(
  from: string,
  family: string,
  dropped: number[],
  weights: Set<number> | undefined,
): number[] {
  const f = parseCss2(from)?.families.find((x) => familyKey(x.name) === familyKey(family));
  const wi = f?.axes.indexOf('wght') ?? -1;
  if (!f || wi < 0) return [];
  if (!weights) return dropped; // computed weights: any might be asked for
  const ii = f.axes.indexOf('ital');
  const out = new Set<number>();
  for (const s of new Set(f.tuples.map((t) => (ii >= 0 ? t[ii]! : '0')))) {
    const avail = f.tuples.filter((t) => (ii >= 0 ? t[ii]! : '0') === s).map((t) => Number(t[wi]));
    for (const d of weights) {
      const w = matchWeight(d, avail);
      if (w !== undefined && dropped.includes(w)) out.add(w);
    }
  }
  return [...out].toSorted((a, b) => a - b);
}
