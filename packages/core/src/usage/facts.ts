// Font facts for the usage builder, computed once per downloaded file.
import { createHash } from 'node:crypto';
import { loadFont } from '../font/hb.ts';
import { toSfnt } from '../font/io.ts';
import { parseFvar } from '../font/tables.ts';
import type { FontFacts } from './capture.ts';

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export async function fontFacts(bytes: Uint8Array): Promise<FontFacts> {
  const sfnt = await toSfnt(bytes);
  const { face } = loadFont(sfnt);
  return {
    sha256: sha256(bytes),
    cmap: new Set(face.collectUnicodes()),
    features: new Set([...face.getTableFeatureTags('GSUB'), ...face.getTableFeatureTags('GPOS')]),
    axes: (parseFvar(sfnt)?.axes ?? []).map(({ tag, min, default: d, max }) => ({ tag, min, default: d, max })),
  };
}
