import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('../../../fixtures/fonts/', import.meta.url);
export const PINNED: Record<string, string> = {
  'InterVariable.ttf': '4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf',
  'Inter-Regular-hinted.woff2': '338239f6b590b8ced3bf857654d32da3fd3663294cd3003651ed57aa3abd7aa1',
  'DejaVuSans.ttf': '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954',
  'SourceSans3-Regular.otf': '08df266400933d3178d081a45f94a08814c3e55b4b7dd2e0ff69cb1329f13ab6',
  'AND-Regular.otf': '494bfaeeea8993a8f6fc8d21d2a9f4c6036dc51fb6e4938ff6f34ce5ad9dd7f2',
};
export const fixture = (name: keyof typeof PINNED & string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(name, dir)));
export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const ASCII = range(0x20, 0x7e);
export const LATIN1 = [...ASCII, ...range(0xa0, 0xff)];
