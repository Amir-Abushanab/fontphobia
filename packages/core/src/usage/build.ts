// The usage builder: page visits + font facts → per-face usage (§7.3–7.6). Pure and deterministic.
import { createHash } from 'node:crypto';
import { formatUnicodeRange, inRanges, rangesFromCodePoints } from '../css/unicode-range.ts';
import {
  featuresOf,
  formatInterval,
  formatSettings,
  formatStyle,
  parseComputedStretch,
  parseFamilyList,
  parseVariationSettings,
  GENERIC_FAMILIES,
  type FeatureValues,
} from '../css/values.ts';
import type { CapturedFace, FontFacts, Run, StyleRow, Visit } from './capture.ts';
import { styleOf, STYLE_PROPS } from './capture.ts';
import { applyDeclared, weightSteps } from './declared.ts';
import { attribute, computedStyle, matchFaces, type Wanted } from './match.ts';
import { phraseAround } from './phrases.ts';
import {
  contentCounterStyles,
  counterChars,
  ellipsisChars,
  emphasisChars,
  fullSizeKana,
  fullWidth,
  hyphenChars,
  LOCALE_INPUT_TYPES,
  maskChars,
  quoteChars,
  synthesizedCapsChars,
} from './rules.ts';

export interface AxisUse {
  weight: Set<number>;
  stretch: Set<number>;
  style: Set<string>;
  size: Set<number>;
  axes: Map<string, Set<number>>;
}
const axisUse = (): AxisUse => ({
  weight: new Set(),
  stretch: new Set(),
  style: new Set(),
  size: new Set(),
  axes: new Map(),
});

export interface FaceUsage {
  id: string;
  key: string;
  family: string;
  descriptors: Record<string, string>;
  sheet: string;
  /** src URLs as declared, resolved. */
  urls: string[];
  /** Files that actually downloaded for this face, by URL. */
  files: Map<string, { sha256?: string; bytes: number }>;
  chars: Set<number>;
  /** Rule name → characters it added (§7.4), including "declared" for states the crawl didn't render. */
  inserted: Map<string, Set<number>>;
  /**
   * Shaping contexts, keyed by feature settings. Words are shared across sizes and weights; each
   * context keeps the range of every axis it was drawn at, so the planner can shape at the ends (§8.3).
   */
  contexts: Map<string, { features: string; axes: Map<string, [number, number]>; words: Set<string> }>;
  rendered: AxisUse;
  declared: AxisUse;
  /** Feature tags CSS enables on this face (value ≠ 0). */
  features: Set<string>;
  editable: boolean;
  locales: Set<string>;
  /** Page → visit labels. */
  pages: Map<string, Set<string>>;
  /** Loaded from local() (not a file fontphobia can change). */
  local: boolean;
  /** The word list hit the cap (§7.6). */
  wordsTruncated: boolean;
  /** A face fontphobia generated: its manifest entry's id, shared by the block's core/ext/rest files. */
  fixedId?: string;
}

export interface PageUsage {
  visits: Set<string>;
  private: boolean;
  /** Face id → characters this page uses. */
  faces: Map<string, Set<number>>;
  fonts: Map<
    string,
    { bytes: number; transfer: number; sha256?: string; status: number; faces: Set<string>; initiator?: string }
  >;
  preloads: Map<string, { crossorigin: string | null; used: boolean; type?: string }>;
  /** Characters drawn by a system font although the stack starts with a web font. */
  fallback: Map<string, Set<number>>;
  /** Characters drawn by a system font in text whose stack starts with one (code blocks in Menlo). */
  system: Set<number>;
  /** Families Chrome reported drawing that the attribution didn't predict. */
  disagreements: Set<string>;
  /** What the largest contentful paint was, over the visits at the default font size. */
  lcp: Set<'text' | 'image'>;
  notes: Set<string>;
}

export interface Usage {
  faces: Map<string, FaceUsage>;
  pages: Map<string, PageUsage>;
  /** Faces declared in CSS that never downloaded on any page. */
  unloaded: Map<string, { family: string; descriptors: Record<string, string>; sheet: string; urls: string[] }>;
}

export interface BuildOptions {
  /** Configured locales (§3): their CLDR quotes are added where `<q>` renders (§7.4). */
  locales?: string[];
  /** Words kept per face (deterministic selection). */
  maxWords?: number;
  /**
   * Files fontphobia generated (manifest output name → entry id and the original descriptors). Their
   * faces fold back into the original face, so words that span core and extended stay whole and a
   * rebuild plans from the same usage as the first build.
   */
  generated?: Map<string, { id: string; descriptors?: Record<string, string> }>;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const label = (v: Visit) =>
  `${v.viewport}${v.fontSize !== 16 ? `@fs${v.fontSize}` : ''}${v.textScale ? `@ts${v.textScale}` : ''}`;
const sha6 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 6);
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'font';
const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === 'data:' ? u : x.pathname + x.search;
  } catch {
    return u;
  }
};
/** Same-origin URLs as paths (the crawl's port changes every run); others in full. */
const relTo = (u: string | undefined, page: string) => {
  if (!u) return u;
  try {
    const x = new URL(u);
    return x.origin === new URL(page).origin ? x.pathname + x.search : u;
  } catch {
    return u;
  }
};

function faceKey(f: CapturedFace): string {
  return [
    f.family.toLowerCase(),
    formatInterval(f.weight),
    formatStyle(f.style),
    formatInterval(f.stretch, '%'),
    formatUnicodeRange(f.unicodeRange),
    f.urls.map(pathOf).join(' '),
  ].join('|');
}

const isSkippable = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
const isSpace = (ch: string) => /\s/u.test(ch);

/**
 * The generated face a served file belongs to: by exact name, or by `<stem>.<role>.<hash8>` inside a
 * bundler's renamed file (Vite: `inter.core.d5804d01.BFg9czMi.woff2`; Next: `inter_core_d5804d01-s.p.….woff2`).
 */
function generatedFor(gen: Map<string, { id: string; descriptors?: Record<string, string> }>, name: string) {
  const exact = gen.get(name);
  if (exact) return exact;
  const flat = name.replace(/[._-]/g, '').toLowerCase();
  for (const [file, g] of gen)
    if (
      flat.includes(
        file
          .replace(/\.woff2$/, '')
          .replace(/[._-]/g, '')
          .toLowerCase(),
      )
    )
      return g;
  return undefined;
}

export function buildUsage(visits: Visit[], facts: Map<string, FontFacts>, opts: BuildOptions = {}): Usage {
  const faces = new Map<string, FaceUsage>();
  const pages = new Map<string, PageUsage>();
  const declaredEver = new Map<string, CapturedFace>();
  const quotesSeen = new Set<string>();
  const qFaces = new Set<FaceUsage>();

  // Sorted input order makes the output independent of crawl concurrency.
  const ordered = [...visits].toSorted((a, b) =>
    a.page < b.page
      ? -1
      : a.page > b.page
        ? 1
        : a.viewport - b.viewport || a.fontSize - b.fontSize || (a.textScale ?? 0) - (b.textScale ?? 0),
  );

  for (const v of ordered) {
    const vl = label(v);
    const page = pages.get(v.page) ?? {
      visits: new Set(),
      private: !!v.private,
      faces: new Map(),
      fonts: new Map(),
      preloads: new Map(),
      fallback: new Map(),
      system: new Set(),
      disagreements: new Set(),
      lcp: new Set(),
      notes: new Set(),
    };
    pages.set(v.page, page);
    page.visits.add(vl);
    if (v.lcp && v.fontSize === 16 && !v.textScale) page.lcp.add(v.lcp);
    for (const n of v.notes) page.notes.add(n);

    const fv: FeatureValues = new Map();
    for (const [fam, type, name, vals] of v.featureValues) {
      const t = fv.get(fam) ?? new Map();
      fv.set(fam, t);
      const m = t.get(type) ?? new Map();
      t.set(type, m);
      m.set(name, vals);
    }

    const byUrl = new Map(v.fonts.map((r) => [r.url, r]));
    // Faces of this visit, with their usage record and loaded file.
    type Live = CapturedFace & { usage: FaceUsage; fact?: FontFacts; url?: string };
    const live: Live[] = [];
    const families = new Map<string, Live[]>();
    for (const f of v.faces) {
      const gen = opts.generated?.size
        ? f.urls.map((x) => generatedFor(opts.generated!, pathOf(x).split(/[?#]/)[0]!.split('/').pop()!)).find(Boolean)
        : undefined;
      const key = gen ? `fontphobia:${gen.id}` : faceKey(f);
      let u = faces.get(key);
      if (!u) {
        u = {
          id: '',
          fixedId: gen?.id,
          key,
          family: f.family,
          descriptors: gen?.descriptors ?? f.descriptors,
          sheet: relTo(f.sheet, v.url)!,
          urls: f.urls.map((x) => relTo(x, v.url)!),
          files: new Map(),
          chars: new Set(),
          inserted: new Map(),
          contexts: new Map(),
          rendered: axisUse(),
          declared: axisUse(),
          features: new Set(),
          editable: false,
          locales: new Set(),
          pages: new Map(),
          local: false,
          wordsTruncated: false,
        };
        faces.set(key, u);
      }
      const url = f.urls.find((x) => {
        const r = byUrl.get(x);
        return r && r.status >= 200 && r.status < 400 && r.sha256;
      });
      const fact = url ? facts.get(byUrl.get(url)!.sha256!) : undefined;
      // local() only when no visit downloaded its file: a page that doesn't use a face (a 404 page)
      // fetches nothing for it, and that isn't evidence of an installed font (@nuxt/fonts lists local() first).
      if (!url && !u.files.size && f.src.some((s) => s.local !== undefined) && !f.urls.some((x) => byUrl.has(x)))
        u.local = true;
      if (url) {
        u.files.set(pathOf(url), { sha256: byUrl.get(url)!.sha256, bytes: byUrl.get(url)!.bytes });
        u.local = false;
      }
      if (!u.local) declaredEver.set(key, f);
      const l: Live = { ...f, usage: u, fact, url };
      live.push(l);
      const k = f.family.toLowerCase();
      families.set(k, [...(families.get(k) ?? []), l]);
    }
    const covers = (f: Live, cp: number) => (f.fact ? f.fact.cmap.has(cp) : f.usage.local);

    // Network: font bytes per page.
    for (const r of v.fonts) {
      const p = pathOf(r.url);
      const e = page.fonts.get(p) ?? {
        bytes: r.bytes,
        transfer: r.transfer,
        sha256: r.sha256,
        status: r.status,
        faces: new Set<string>(),
        initiator: relTo(r.initiator, v.url),
      };
      page.fonts.set(p, e);
      for (const l of live) if (l.url === r.url) e.faces.add(l.usage.key);
    }

    // Which runs Chrome says were drawn by which platform fonts.
    const platformOf = new Map<number, (typeof v.platform)[number]>();
    for (const h of v.platform) for (const r of h.runs) platformOf.set(r, h);

    // Parse styles once.
    type Parsed = {
      row: StyleRow;
      s: ReturnType<typeof styleOf>;
      stack: string[];
      want: Wanted;
      size: number;
      locale: string;
    };
    const parse = (row: StyleRow): Parsed => {
      const s = styleOf(row);
      return {
        row,
        s,
        stack: parseFamilyList(s['font-family']),
        locale: s['-webkit-locale'].replace(/^["']|["']$/g, '') || v.lang || '',
        want: {
          weight: Number(s['font-weight']) || 400,
          style: computedStyle(s['font-style']),
          stretch: parseComputedStretch(s['font-stretch']),
        },
        size: parseFloat(s['font-size']) || 16,
      };
    };
    const styleCache = new Map<number, Parsed>();
    const styleAt = (i: number) => {
      let p = styleCache.get(i);
      if (!p) {
        p = parse(v.styles[i]!);
        styleCache.set(i, p);
      }
      return p;
    };

    const ctxCache = new Map<
      string,
      { features: string; variations: string; key: string; enabled: string[]; axes: [string, number][] }
    >();
    const contextOf = (st: Parsed, f: Live) => {
      const ck = `${st.row.join('\u0001')}\u0002${f.usage.key}`;
      let c = ctxCache.get(ck);
      if (c) return c;
      const feats = featuresOf(
        {
          fontFeatureSettings: st.s['font-feature-settings'],
          fontVariantLigatures: st.s['font-variant-ligatures'],
          fontVariantCaps: st.s['font-variant-caps'],
          fontVariantNumeric: st.s['font-variant-numeric'],
          fontVariantEastAsian: st.s['font-variant-east-asian'],
          fontVariantPosition: st.s['font-variant-position'],
          fontVariantAlternates: st.s['font-variant-alternates'],
          fontKerning: st.s['font-kerning'],
          letterSpacing: st.s['letter-spacing'],
        },
        f.family,
        fv,
        f.descriptors['font-feature-settings'],
      );
      if (st.s['writing-mode'].startsWith('vertical')) feats.set('vert', 1);
      const coords = new Map<string, number>();
      const ax = new Map((f.fact?.axes ?? []).map((a) => [a.tag, a]));
      const clamp = (tag: string, val: number) => {
        const a = ax.get(tag);
        return a ? Math.min(a.max, Math.max(a.min, val)) : val;
      };
      if (ax.has('wght'))
        coords.set('wght', clamp('wght', Math.min(f.weight[1], Math.max(f.weight[0], st.want.weight))));
      if (ax.has('wdth'))
        coords.set('wdth', clamp('wdth', Math.min(f.stretch[1], Math.max(f.stretch[0], st.want.stretch))));
      if (ax.has('ital')) coords.set('ital', st.want.style.kind === 'italic' && f.style.kind !== 'normal' ? 1 : 0);
      if (ax.has('slnt') && st.want.style.kind === 'oblique') coords.set('slnt', clamp('slnt', -st.want.style.min));
      if (ax.has('opsz') && st.s['font-optical-sizing'].trim() !== 'none') coords.set('opsz', clamp('opsz', st.size));
      for (const [t, val] of [
        ...parseVariationSettings(f.descriptors['font-variation-settings']),
        ...parseVariationSettings(st.s['font-variation-settings']),
      ])
        coords.set(t, ax.has(t) ? clamp(t, val) : val);
      const axes = [...coords].map(([t, val]) => [t, r3(val)] as [string, number]);
      c = {
        features: formatSettings(feats),
        variations: formatSettings(axes),
        key: '',
        enabled: [...feats].filter(([, val]) => val !== 0).map(([t]) => t),
        axes,
      };
      c.key = c.features;
      ctxCache.set(ck, c);
      return c;
    };

    const record = (f: Live, st: Parsed, declared: boolean) => {
      const u = f.usage;
      const pv = u.pages.get(v.page) ?? new Set<string>();
      u.pages.set(v.page, pv);
      pv.add(vl);
      const a = declared ? u.declared : u.rendered;
      a.weight.add(st.want.weight);
      a.stretch.add(st.want.stretch);
      a.style.add(formatStyle(st.want.style));
      if (st.s['font-optical-sizing'].trim() !== 'none') a.size.add(r3(st.size));
      const c = contextOf(st, f);
      for (const [t, val] of c.axes) {
        const s = a.axes.get(t) ?? new Set<number>();
        a.axes.set(t, s);
        s.add(val);
      }
      for (const t of c.enabled) u.features.add(t);
      if (st.locale) u.locales.add(st.locale);
      return c;
    };

    const pageChars = (f: Live) => {
      let s = page.faces.get(f.usage.key);
      if (!s) {
        s = new Set();
        page.faces.set(f.usage.key, s);
      }
      return s;
    };

    const installed = (runIndex: number) => (fam: string) => {
      if (GENERIC_FAMILIES.has(fam.toLowerCase())) return true;
      const h = platformOf.get(runIndex);
      if (!h) return true;
      return h.fonts.some(
        (p) =>
          !p.custom &&
          (p.family.toLowerCase() === fam.toLowerCase() ||
            p.postscript.toLowerCase() === fam.toLowerCase().replace(/\s+/g, '')),
      );
    };

    /** Attribute every character of `text`; returns the face per code point (null for system). */
    const attributeText = (
      text: string,
      st: Parsed,
      runIndex: number,
      how: { declared?: boolean; rule?: string; words?: boolean },
    ) => {
      const out: (Live | null)[] = [];
      const isInst = installed(runIndex);
      const webFirst = st.stack.length > 0 && families.has(st.stack[0]!.toLowerCase());
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (isSkippable(cp)) {
          out.push(null);
          continue;
        }
        const r = attribute(st.stack, cp, st.want, families, covers, isInst);
        if ('face' in r) {
          const f = r.face;
          f.usage.chars.add(cp);
          pageChars(f).add(cp);
          if (how.rule) {
            const s = f.usage.inserted.get(how.rule) ?? new Set<number>();
            f.usage.inserted.set(how.rule, s);
            s.add(cp);
          }
          record(f, st, !!how.declared);
          out.push(f);
        } else {
          if (!isSpace(ch) && !how.rule) {
            if (webFirst) {
              const s = page.fallback.get(r.system) ?? new Set<number>();
              page.fallback.set(r.system, s);
              s.add(cp);
            } else page.system.add(cp);
          }
          out.push(null);
        }
      }
      if (how.words && !v.private && !how.rule) addWords(text, out, st);
      return out;
    };

    const addWords = (text: string, owners: (Live | null)[], st: Parsed) => {
      const chars = [...text];
      /** The face's shaping context for this style, with its axis ranges widened to the style's values. */
      const contextFor = (f: Live) => {
        const c = contextOf(st, f);
        const ctx = f.usage.contexts.get(c.key) ?? {
          features: c.features,
          axes: new Map<string, [number, number]>(),
          words: new Set<string>(),
        };
        f.usage.contexts.set(c.key, ctx);
        for (const [t, val] of c.axes) {
          const r = ctx.axes.get(t);
          if (!r) ctx.axes.set(t, [val, val]);
          else {
            r[0] = Math.min(r[0], val);
            r[1] = Math.max(r[1], val);
          }
        }
        return ctx;
      };
      /** Each word of the run, and the face that draws all of it (undefined: none, or more than one). */
      const tokens: { text: string; face?: Live }[] = [];
      let i = 0;
      while (i < chars.length) {
        if (isSpace(chars[i]!)) {
          i++;
          continue;
        }
        let j = i;
        while (j < chars.length && !isSpace(chars[j]!)) j++;
        // Segments of one face inside the token [i, j).
        let s = i;
        while (s < j) {
          const f = owners[s];
          let e = s + 1;
          while (e < j && owners[e]?.usage === f?.usage) e++;
          if (f) {
            const before = s === i && i > 0 ? ' ' : '';
            const after = e === j && j < chars.length ? ' ' : '';
            contextFor(f).words.add(before + chars.slice(s, e).join('') + after);
          }
          if (s === i && e === j) tokens.push({ text: chars.slice(i, j).join(''), face: f ?? undefined });
          else if (s === i) tokens.push({ text: chars.slice(i, j).join('') });
          s = e;
        }
        i = j;
      }
      // A word of symbols only, with its neighbours the same face draws (phrases.ts).
      tokens.forEach((t, k) => {
        const f = t.face;
        if (!f) return;
        const side = (n: (typeof tokens)[number] | undefined) => (n?.face?.usage === f.usage ? n.text : undefined);
        const phrase = phraseAround(side(tokens[k - 1]), t.text, side(tokens[k + 1]));
        if (phrase) contextFor(f).words.add(phrase);
      });
    };

    const runAttributed = new Map<number, (Live | null)[]>();
    const processRun = (run: Run, ri: number, row: StyleRow, declared?: string) => {
      const st = declared ? parse(row) : styleAt(run.style);
      const s = st.s;
      let text = run.text;
      if (run.kind === 'full-width') text = fullWidth(text);
      else if (run.kind === 'full-size-kana') text = fullSizeKana(text);
      const owners = attributeText(text, st, ri, {
        declared: !!declared,
        words: run.kind !== 'password',
        rule: declared
          ? `declared ${declared}`
          : run.kind === 'full-width' || run.kind === 'full-size-kana'
            ? `text-transform: ${run.kind}`
            : undefined,
      });
      if (!declared) runAttributed.set(ri, owners);
      const add = (chars: string, rule: string, style: typeof st = st) => {
        if (chars) attributeText(chars, style, ri, { rule, declared: !!declared });
      };
      add(hyphenChars(s.hyphens, s['hyphenate-character'], run.text), 'hyphens');
      add(ellipsisChars(s['text-overflow'], s['-webkit-line-clamp']), 'text-overflow');
      if (run.ellipsis !== undefined) {
        const b = styleAt(run.ellipsis);
        add(ellipsisChars(b.s['text-overflow'], b.s['-webkit-line-clamp']), 'text-overflow', b);
      }
      add(maskChars(run.kind, s['-webkit-text-security']), 'password');
      add(emphasisChars(s['text-emphasis-style'], s['writing-mode']), 'text-emphasis');
      if (run.kind === 'marker') add(counterChars(s['list-style-type'], v.counterStyles), 'list markers');
      if (run.kind === 'before' || run.kind === 'after' || run.kind === 'marker')
        for (const cs of contentCounterStyles(s.content)) add(counterChars(cs, v.counterStyles), 'counter()');
      if (run.kind === 'value' && run.inputType && LOCALE_INPUT_TYPES.has(run.inputType)) {
        const loc = st.locale || v.lang || 'en';
        add(v.locales[loc] ?? v.locales[loc.split('-')[0]!] ?? '', `input type=${run.inputType}`);
      }
      // Small caps the browser synthesizes: per face, after attribution.
      const caps = s['font-variant-caps'];
      if (caps && caps !== 'normal') {
        const byFace = new Map<Live, string>();
        [...text].forEach((ch, k) => {
          const f = owners[k];
          if (f) byFace.set(f, (byFace.get(f) ?? '') + ch);
        });
        for (const [f, t] of byFace) {
          const extra = synthesizedCapsChars(caps, f.fact?.features ?? new Set(), t, st.locale);
          if (extra) add(extra, 'synthesized small caps');
        }
      }
      if (run.q)
        for (const f of owners)
          if (f) {
            qFaces.add(f.usage);
            quotesSeen.add(st.locale.split('-')[0]!);
          }
      // Editable text can be anything the user types: every face the stack's first web family matches (§7.4).
      if (run.editable) {
        for (const f of owners) if (f) f.usage.editable = true;
        const fam = st.stack.find((x) => families.has(x.toLowerCase()));
        if (fam) for (const f of matchFaces(families.get(fam.toLowerCase())!, st.want)) f.usage.editable = true;
      }
    };

    v.runs.forEach((run, ri) => processRun(run, ri, v.styles[run.style]!));

    // Declared values: states the crawl didn't render (§7.5).
    const kf = new Map(v.keyframes.map((k) => [k.name, k]));
    const animated = new Set<string>();
    const expand = (run: Run, ri: number, decls: Record<string, string>, origin: string) => {
      if (origin && Object.keys(decls).some((k) => k !== 'animation' && k !== 'animation-name'))
        processRun(run, ri, applyDeclared(v.styles[run.style]!, decls), origin);
      const anim = decls['animation-name'] ?? decls.animation;
      if (anim) {
        for (const name of anim
          .split(',')
          .map((x) => x.trim().split(/\s+/))
          .flat()) {
          const k = kf.get(name);
          if (!k || animated.has(`${ri}\u0000${name}`)) continue;
          animated.add(`${ri}\u0000${name}`);
          const base = v.styles[run.style]!;
          const weights = [Number(styleOf(base)['font-weight']) || 400];
          for (const fr of k.frames) {
            const row = applyDeclared(base, fr);
            processRun(run, ri, row, `@keyframes ${name}`);
            weights.push(Number(styleOf(row)['font-weight']) || 400);
          }
          const wi = STYLE_PROPS.indexOf('font-weight');
          for (const w of weightSteps(Math.min(...weights), Math.max(...weights))) {
            const row = [...base];
            row[wi] = String(w);
            processRun(run, ri, row, `@keyframes ${name}`);
          }
        }
      }
    };
    for (const h of v.declared)
      for (const ri of h.runs) {
        const run = v.runs[ri];
        if (run) expand(run, ri, h.decls, h.origin);
      }
    v.runs.forEach((run, ri) => {
      const an = styleOf(v.styles[run.style]!)['animation-name'];
      if (an && an !== 'none') expand(run, ri, { 'animation-name': an }, '');
    });

    // A preload is used when a face that draws text on this page loads that URL.
    const usedUrls = new Set(live.filter((l) => l.url && page.faces.get(l.usage.key)?.size).map((l) => l.url!));
    for (const p of v.preloads) {
      const prev = page.preloads.get(pathOf(p.href));
      page.preloads.set(pathOf(p.href), {
        crossorigin: p.crossorigin,
        type: p.type,
        used: usedUrls.has(p.href) || !!prev?.used,
      });
    }

    // Cross-check with what Chrome says drew each element (§7.3 step 2).
    for (const h of v.platform) {
      const predicted = new Set<string>();
      for (const ri of h.runs)
        for (const f of runAttributed.get(ri) ?? []) if (f) predicted.add(f.family.toLowerCase());
      for (const pf of h.fonts) {
        if (!pf.custom || pf.glyphs === 0 || predicted.has(pf.family.toLowerCase())) continue;
        const cands = families.get(pf.family.toLowerCase());
        if (!cands) continue;
        page.disagreements.add(pf.family);
        for (const ri of h.runs) {
          const run = v.runs[ri]!;
          const st = styleAt(run.style);
          for (const ch of run.text) {
            const cp = ch.codePointAt(0)!;
            if (isSkippable(cp)) continue;
            for (const f of cands)
              if (inRanges(f.unicodeRange, cp) && covers(f, cp)) {
                f.usage.chars.add(cp);
                pageChars(f).add(cp);
                const s = f.usage.inserted.get('platform cross-check') ?? new Set<number>();
                f.usage.inserted.set('platform cross-check', s);
                s.add(cp);
                record(f, st, false);
              }
          }
        }
      }
    }
  }

  // CLDR quotes for configured locales the crawl didn't render (§7.4 `<q>`).
  for (const loc of opts.locales ?? []) {
    if (quotesSeen.has(loc.split('-')[0]!)) continue;
    for (const u of qFaces) {
      const s = u.inserted.get(`quotes (${loc})`) ?? new Set<number>();
      u.inserted.set(`quotes (${loc})`, s);
      for (const ch of quoteChars(loc)) {
        const cp = ch.codePointAt(0)!;
        s.add(cp);
        u.chars.add(cp);
      }
    }
  }

  // Stable, readable ids.
  const groups = new Map<string, FaceUsage[]>();
  for (const u of faces.values()) {
    const base = [
      slug(u.family),
      (u.descriptors['font-weight'] ?? '400').trim().replace(/\s+/g, '-'),
      slug(u.descriptors['font-style'] ?? 'normal'),
      u.descriptors['font-stretch'] ? slug(u.descriptors['font-stretch']) : '',
    ]
      .filter(Boolean)
      .join('-');
    groups.set(base, [...(groups.get(base) ?? []), u]);
  }
  const used = new Map<string, FaceUsage>();
  // A generated face keeps its entry's id; counting it in its group keeps the others' ids as they were.
  for (const [base, us] of groups)
    for (const u of us) {
      u.id = u.fixedId ?? (us.length > 1 ? `${base}-${sha6(u.key)}` : base);
      used.set(u.id, u);
    }
  for (const p of pages.values()) {
    p.faces = new Map([...p.faces].map(([k, s]) => [faces.get(k)!.id, s]));
    for (const f of p.fonts.values()) f.faces = new Set([...f.faces].map((k) => faces.get(k)!.id));
  }
  for (const u of used.values()) if (opts.maxWords) capWords(u, opts.maxWords);

  const unloaded = new Map<string, Usage['unloaded'] extends Map<string, infer V> ? V : never>();
  for (const [key, f] of declaredEver) {
    const u = faces.get(key)!;
    if (u.chars.size) continue;
    unloaded.set(u.id, { family: f.family, descriptors: f.descriptors, sheet: u.sheet, urls: u.urls });
    used.delete(u.id);
  }
  return { faces: used, pages, unloaded };
}

/** Keep at most `max` words per face: words with non-ASCII characters first, then shortest, then alphabetical. */
function capWords(u: FaceUsage, max: number) {
  const all: [string, string][] = [];
  for (const [k, c] of u.contexts) for (const w of c.words) all.push([k, w]);
  if (all.length <= max) return;
  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);
  all.sort(
    ([, a], [, b]) => Number(ascii(a)) - Number(ascii(b)) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const keep = new Set(all.slice(0, max).map(([k, w]) => `${k}\u0000${w}`));
  for (const [k, c] of u.contexts) c.words = new Set([...c.words].filter((w) => keep.has(`${k}\u0000${w}`)));
  u.wordsTruncated = true;
}

export const charsToRanges = (s: Iterable<number>) => formatUnicodeRange(rangesFromCodePoints(s));
