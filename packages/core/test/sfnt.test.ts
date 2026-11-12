import { expect, test } from 'vitest';
import { checksum, readSfnt, writeSfnt, withTables, view } from '../src/index.ts';
import { fixture } from './helpers.ts';

const font = fixture('DejaVuSans.ttf');

test('canonical write is idempotent and keeps every table byte-for-byte', () => {
  const once = writeSfnt(readSfnt(font));
  expect(writeSfnt(readSfnt(once))).toEqual(once);
  const a = readSfnt(font).tables, b = readSfnt(once).tables;
  expect([...b.keys()].toSorted()).toEqual([...a.keys()].toSorted());
  for (const [tag, data] of a) if (tag !== 'head') expect(b.get(tag)).toEqual(data);
});

test('table checksums and head.checkSumAdjustment are valid', () => {
  const out = writeSfnt(readSfnt(font));
  const dv = view(out);
  const n = dv.getUint16(4);
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...out.subarray(rec, rec + 4));
    const off = dv.getUint32(rec + 8), len = dv.getUint32(rec + 12);
    const data = out.slice(off, off + len);
    if (tag === 'head') view(data).setUint32(8, 0);
    expect(dv.getUint32(rec + 4), tag).toBe(checksum(data));
  }
  expect(checksum(out)).toBe(0xb1b0afba);
});

test('withTables replaces and removes tables', () => {
  const out = withTables(font, { DSIG: null, 'zzzz': new Uint8Array([1, 2, 3]) });
  const t = readSfnt(out).tables;
  expect(t.has('DSIG')).toBe(false);
  expect(t.get('zzzz')).toEqual(new Uint8Array([1, 2, 3]));
});
