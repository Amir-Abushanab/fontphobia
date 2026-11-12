// Shaping equivalence (PLAN §10.2): shape each case with the source font, then with the output
// files split by unicode-range the way Chrome splits text (spike 2), and compare outlines,
// advances, offsets and clusters.
import { hb, loadFont, setVariations, type LoadedFont } from '../font/hb.ts';
import { inRanges, type Range } from '../css/unicode-range.ts';

export interface OutputFile {
  /** Decoded sfnt of the shipped file. */
  sfnt: Uint8Array;
  /** The file's unicode-range (from its real cmap, §9.6). */
  ranges: Range[];
}

export interface ShapeCase {
  text: string;
  /** CSS-style feature strings understood by HarfBuzz: "tnum", "-kern", "ss01=1". */
  features?: string[];
  variations?: Record<string, number>;
}

export type Verdict =
  | { kind: 'identical' }
  | { kind: 'rounding'; maxPointDelta: number; maxAdvanceDelta: number; widthDelta: number }
  | { kind: 'regression'; reason: string };

export interface CaseResult {
  case: ShapeCase;
  verdict: Verdict;
}

interface Glyph {
  outline: number[];
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  cluster: number;
}

const ROUNDING_POINT = 2.5;
const ROUNDING_ADVANCE = 1;

const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const varKey = (v?: Record<string, number>) => JSON.stringify(Object.entries(v ?? {}).toSorted());

class Shaper {
  private outlines = new Map<string, number[]>();
  private lastVar = '';
  readonly f: LoadedFont;
  constructor(f: LoadedFont) {
    this.f = f;
  }

  shape(text: string, c: ShapeCase, clusterBase: number, clusterOverride?: number): Glyph[] {
    const vk = varKey(c.variations);
    if (vk !== this.lastVar) {
      setVariations(this.f.font, c.variations);
      this.lastVar = vk;
    }
    const buf = new hb.Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();
    const feats = (c.features ?? []).map((s) => {
      const f = hb.Feature.fromString(s);
      if (!f) throw new Error(`Bad feature string ${JSON.stringify(s)}`);
      return f;
    });
    hb.shape(this.f.font, buf, feats);
    const pos = buf.getGlyphPositions();
    return buf.getGlyphInfos().map((g, i) => ({
      outline: this.outline(g.codepoint, vk),
      ax: pos[i]!.xAdvance,
      ay: pos[i]!.yAdvance,
      dx: pos[i]!.xOffset,
      dy: pos[i]!.yOffset,
      cluster: clusterOverride ?? clusterBase + g.cluster,
    }));
  }

  private outline(gid: number, vk: string): number[] {
    const key = `${gid}|${vk}`;
    let o = this.outlines.get(key);
    if (!o) {
      o = this.f.font.glyphToJson(gid).flatMap((cmd) => cmd.values);
      this.outlines.set(key, o);
    }
    return o;
  }
}

/** Order-independent of direction: stable sort by cluster. */
const byCluster = (g: Glyph[]) =>
  g
    .map((x, i) => [x, i] as const)
    .toSorted((a, b) => a[0].cluster - b[0].cluster || a[1] - b[1])
    .map(([x]) => x);

export function checkShaping(source: Uint8Array, files: OutputFile[], cases: ShapeCase[]): CaseResult[] {
  const src = new Shaper(loadFont(source));
  const outs = files.map((f) => ({ shaper: new Shaper(loadFont(f.sfnt)), ranges: f.ranges }));
  const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });

  return cases.map((c): CaseResult => {
    const whole = byCluster(src.shape(c.text, c, 0));

    // Segment into grapheme clusters, give each to the first file covering all its code points.
    // When none does, Chrome tries the NFC-composed cluster (spike 2).
    type Run = { file: number; text: string; start: number; override?: number };
    const runs: Run[] = [];
    for (const { segment, index } of seg.segment(c.text)) {
      const covers = (s: string) => outs.findIndex((o) => [...s].every((ch) => inRanges(o.ranges, ch.codePointAt(0)!)));
      let file = covers(segment);
      let text = segment;
      let override: number | undefined;
      if (file < 0) {
        const nfc = segment.normalize('NFC');
        file = nfc !== segment ? covers(nfc) : -1;
        if (file < 0) {
          const miss = [...segment]
            .map((ch) => ch.codePointAt(0)!)
            .filter((cp) => !outs.some((o) => inRanges(o.ranges, cp)));
          return {
            case: c,
            verdict: {
              kind: 'regression',
              reason: `no output file covers ${miss.map(hex).join(' ') || hex(segment.codePointAt(0)!)}`,
            },
          };
        }
        text = nfc;
        override = index;
      }
      const last = runs[runs.length - 1];
      if (last && last.file === file && last.override === undefined && override === undefined) last.text += text;
      else runs.push({ file, text, start: index, override });
    }
    const split = byCluster(runs.flatMap((r) => outs[r.file]!.shaper.shape(r.text, c, r.start, r.override)));

    return { case: c, verdict: compare(whole, split) };
  });
}

function compare(a: Glyph[], b: Glyph[]): Verdict {
  if (a.length !== b.length) return { kind: 'regression', reason: `glyph count ${a.length} → ${b.length}` };
  let maxPoint = 0,
    maxAdv = 0,
    exact = true;
  let wa = 0,
    wb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!,
      y = b[i]!;
    wa += x.ax;
    wb += y.ax;
    if (x.cluster !== y.cluster)
      return { kind: 'regression', reason: `glyph ${i}: cluster ${x.cluster} → ${y.cluster}` };
    if (x.outline.length !== y.outline.length)
      return { kind: 'regression', reason: `glyph ${i} (cluster ${x.cluster}): different glyph` };
    let glyphMax = 0;
    for (let k = 0; k < x.outline.length; k++) glyphMax = Math.max(glyphMax, Math.abs(x.outline[k]! - y.outline[k]!));
    if (glyphMax > ROUNDING_POINT)
      return {
        kind: 'regression',
        reason: `glyph ${i} (cluster ${x.cluster}): different glyph (outline moved ${glyphMax.toFixed(1)} units)`,
      };
    if (glyphMax) {
      exact = false;
      maxPoint = Math.max(maxPoint, glyphMax);
    }
    for (const [p, q, what] of [
      [x.ax, y.ax, 'advance'],
      [x.ay, y.ay, 'advance'],
      [x.dx, y.dx, 'offset'],
      [x.dy, y.dy, 'offset'],
    ] as const) {
      const d = Math.abs(p - q);
      if (!d) continue;
      exact = false;
      if (what === 'offset' || d > ROUNDING_ADVANCE)
        return { kind: 'regression', reason: `glyph ${i} (cluster ${x.cluster}): ${what} ${p} → ${q}` };
      maxAdv = Math.max(maxAdv, d);
    }
  }
  if (exact) return { kind: 'identical' };
  return { kind: 'rounding', maxPointDelta: maxPoint, maxAdvanceDelta: maxAdv, widthDelta: wb - wa };
}
