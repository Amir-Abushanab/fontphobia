// `fontphobia inspect`: one font's format, tables, axes, features, hinting and licensing bits.
import { createHash } from 'node:crypto';
import { detectFormat, toSfnt, type FontFormat } from './io.ts';
import { loadFont } from './hb.ts';
import { readSfnt } from './sfnt.ts';
import {
  glyfInstructionBytes,
  nameStrings,
  numGlyphs,
  parseFvar,
  parseGasp,
  parseHead,
  parseHhea,
  parseOs2,
  type Axis,
  type FsType,
} from './tables.ts';
import { rangesFromCodePoints, formatUnicodeRange } from '../css/unicode-range.ts';

export interface Inspection {
  file: {
    format: FontFormat;
    bytes: number;
    sha256: string;
    sfntBytes: number;
    outlines: 'truetype' | 'cff' | 'cff2' | 'unknown';
  };
  names: Record<string, string>;
  glyphs: number;
  unicodes: { count: number; ranges: string };
  axes: (Axis & { name?: string })[];
  namedInstances: number;
  features: { GSUB: string[]; GPOS: string[]; scripts: string[] };
  hinting: {
    truetype: boolean;
    fpgm: number;
    prep: number;
    cvt: number;
    glyphInstructions: number;
    gasp?: { maxPPEM: number; behavior: number }[];
  };
  metrics: {
    unitsPerEm: number;
    hhea: { ascender: number; descender: number; lineGap: number };
    typo?: { ascender: number; descender: number; lineGap: number; useTypoMetrics: boolean };
    win?: { ascent: number; descent: number };
  };
  os2?: { weightClass: number; widthClass: number; fsType: FsType };
  tables: { tag: string; bytes: number }[];
}

export async function inspectFont(bytes: Uint8Array): Promise<Inspection> {
  const format = detectFormat(bytes);
  const sfnt = await toSfnt(bytes);
  const { tables } = readSfnt(sfnt);
  const { face } = loadFont(sfnt);
  const names = nameStrings(sfnt);
  const fvar = parseFvar(sfnt);
  const os2 = parseOs2(sfnt);
  const head = parseHead(sfnt);
  const hhea = parseHhea(sfnt);
  const uniq = (xs: string[]) => [...new Set(xs)].toSorted();
  const outlines = tables.has('glyf')
    ? 'truetype'
    : tables.has('CFF2')
      ? 'cff2'
      : tables.has('CFF ')
        ? 'cff'
        : 'unknown';
  return {
    file: {
      format,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sfntBytes: sfnt.byteLength,
      outlines,
    },
    names: Object.fromEntries([...names].map(([k, v]) => [String(k), v])),
    glyphs: numGlyphs(sfnt),
    unicodes: (() => {
      const u = [...face.collectUnicodes()];
      return { count: u.length, ranges: formatUnicodeRange(rangesFromCodePoints(u)) };
    })(),
    axes: (fvar?.axes ?? []).map((a) => ({ ...a, name: names.get(a.nameID) })),
    namedInstances: fvar?.instanceCount ?? 0,
    features: {
      GSUB: uniq(face.getTableFeatureTags('GSUB')),
      GPOS: uniq(face.getTableFeatureTags('GPOS')),
      scripts: uniq([...face.getTableScriptTags('GSUB'), ...face.getTableScriptTags('GPOS')]),
    },
    hinting: {
      truetype: tables.has('fpgm') || tables.has('prep') || tables.has('cvt '),
      fpgm: tables.get('fpgm')?.byteLength ?? 0,
      prep: tables.get('prep')?.byteLength ?? 0,
      cvt: tables.get('cvt ')?.byteLength ?? 0,
      glyphInstructions: glyfInstructionBytes(sfnt),
      gasp: parseGasp(sfnt)?.ranges,
    },
    metrics: {
      unitsPerEm: head.unitsPerEm,
      hhea: { ascender: hhea.ascender, descender: hhea.descender, lineGap: hhea.lineGap },
      typo: os2 && {
        ascender: os2.sTypoAscender,
        descender: os2.sTypoDescender,
        lineGap: os2.sTypoLineGap,
        useTypoMetrics: os2.useTypoMetrics,
      },
      win: os2 && { ascent: os2.usWinAscent, descent: os2.usWinDescent },
    },
    os2: os2 && { weightClass: os2.usWeightClass, widthClass: os2.usWidthClass, fsType: os2.fsType },
    tables: [...tables].map(([tag, d]) => ({ tag, bytes: d.byteLength })).toSorted((a, b) => (a.tag < b.tag ? -1 : 1)),
  };
}

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

export function formatInspection(i: Inspection): string {
  const L: string[] = [];
  const fam = i.names['16'] ?? i.names['1'] ?? '?';
  const sub = i.names['17'] ?? i.names['2'] ?? '';
  L.push(`${fam} ${sub}`.trim() + `  (${i.file.format}, ${kb(i.file.bytes)}, ${i.file.outlines} outlines)`);
  if (i.names['5']) L.push(`  ${i.names['5']}`);
  L.push(`  sha256 ${i.file.sha256}`);
  L.push('');
  L.push(`Glyphs     ${i.glyphs}`);
  L.push(
    `Characters ${i.unicodes.count}  ${i.unicodes.ranges.length > 120 ? i.unicodes.ranges.slice(0, 117) + '…' : i.unicodes.ranges}`,
  );
  if (i.axes.length) {
    L.push(
      `Axes       ${i.axes.map((a) => `${a.tag} ${a.min}–${a.max} (default ${a.default})${a.hidden ? ' hidden' : ''}`).join(', ')}; ${i.namedInstances} named instances`,
    );
  } else L.push('Axes       none (static)');
  L.push(`Scripts    ${i.features.scripts.join(' ') || 'none'}`);
  L.push(`GSUB       ${i.features.GSUB.join(' ') || 'none'}`);
  L.push(`GPOS       ${i.features.GPOS.join(' ') || 'none'}`);
  const h = i.hinting;
  L.push(
    `Hinting    ${h.truetype || h.glyphInstructions ? `TrueType: fpgm ${kb(h.fpgm)}, prep ${kb(h.prep)}, cvt ${kb(h.cvt)}, glyph instructions ${kb(h.glyphInstructions)}` : i.file.outlines.startsWith('cff') ? 'CFF (hints not measured)' : 'none'}${h.gasp ? `; gasp ${h.gasp.map((r) => `≤${r.maxPPEM}:${r.behavior}`).join(' ')}` : ''}`,
  );
  const m = i.metrics;
  L.push(
    `Metrics    upem ${m.unitsPerEm}; hhea ${m.hhea.ascender}/${m.hhea.descender}/${m.hhea.lineGap}${m.typo ? `; typo ${m.typo.ascender}/${m.typo.descender}/${m.typo.lineGap}${m.typo.useTypoMetrics ? ' (USE_TYPO_METRICS)' : ''}` : ''}${m.win ? `; win ${m.win.ascent}/${m.win.descent}` : ''}`,
  );
  if (i.os2) {
    const f = i.os2.fsType;
    L.push(
      `Embedding  fsType 0x${f.raw.toString(16).padStart(4, '0')}: ${f.embedding}${f.noSubsetting ? ', NO SUBSETTING' : ''}${f.bitmapOnly ? ', bitmap only' : ''}`,
    );
  }
  const lic = i.names['13'] ?? i.names['14'];
  if (lic) L.push(`License    ${lic.split('\n')[0]!.slice(0, 110)}${i.names['14'] ? `  ${i.names['14']}` : ''}`);
  L.push('');
  L.push('Tables');
  for (const t of [...i.tables].toSorted((a, b) => b.bytes - a.bytes))
    L.push(`  ${t.tag.padEnd(4)} ${kb(t.bytes).padStart(10)}`);
  return L.join('\n');
}
