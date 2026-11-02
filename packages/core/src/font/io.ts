// Font container formats: detect, decode to sfnt, encode WOFF2.
import { inflateSync } from 'node:zlib';
import wawoff2Module from 'wawoff2';
import { untag, view, writeSfnt, type Sfnt } from './sfnt.ts';

export type FontFormat = 'woff2' | 'woff' | 'truetype' | 'opentype' | 'collection';

export function detectFormat(buf: Uint8Array): FontFormat {
  if (buf.byteLength < 4) throw new Error('Not a font: too short');
  const sig = untag(view(buf).getUint32(0));
  switch (sig) {
    case 'wOF2': return 'woff2';
    case 'wOFF': return 'woff';
    case 'OTTO': return 'opentype';
    case 'ttcf': return 'collection';
    case 'true':
    case '\0\x01\0\0': return 'truetype';
    default: throw new Error(`Not a font: unknown signature ${JSON.stringify(sig)}`);
  }
}

// wawoff2 2.0.1 resolves with a view into its Emscripten heap, so overlapping calls corrupt
// each other's output (spike 4). Every call goes through one queue, and each result is
// copied before the next call starts.
interface Wawoff2 {
  compress(b: Uint8Array): Promise<Uint8Array>;
  decompress(b: Uint8Array): Promise<Uint8Array>;
}
const wawoff2 = wawoff2Module as unknown as Wawoff2;
let queue: Promise<unknown> = Promise.resolve();
function serial(fn: (w: Wawoff2, b: Uint8Array) => Promise<Uint8Array>) {
  return (b: Uint8Array): Promise<Uint8Array> => {
    const run = queue.then(async () => {
      return new Uint8Array(await fn(wawoff2, b)).slice();
    });
    queue = run.catch(() => undefined);
    return run;
  };
}
export const woff2Compress = serial((w, b) => w.compress(b));
export const woff2Decompress = serial((w, b) => w.decompress(b));

function decodeWoff1(buf: Uint8Array): Uint8Array {
  const dv = view(buf);
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = untag(dv.getUint32(o));
    const offset = dv.getUint32(o + 4);
    const compLength = dv.getUint32(o + 8);
    const origLength = dv.getUint32(o + 12);
    const raw = buf.subarray(offset, offset + compLength);
    const data = compLength < origLength ? new Uint8Array(inflateSync(raw)) : raw.slice();
    if (data.byteLength !== origLength) throw new Error(`WOFF table '${tag}' decoded to the wrong length`);
    tables.set(tag, data);
  }
  return writeSfnt({ flavor, tables } satisfies Sfnt);
}

/** Decode any supported container to a plain sfnt. */
export async function toSfnt(buf: Uint8Array): Promise<Uint8Array> {
  const format = detectFormat(buf);
  switch (format) {
    case 'woff2': return woff2Decompress(buf);
    case 'woff': return decodeWoff1(buf);
    case 'truetype':
    case 'opentype': return buf;
    case 'collection': throw new Error('Font collections (.ttc) are not supported');
  }
}
