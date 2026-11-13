// wawoff2: are concurrent compress() calls safe?
import wawoff2 from 'wawoff2';
import { readFileSync } from 'node:fs';
import { subset } from '../lib/hb.mjs';
const src = new Uint8Array(readFileSync(new URL('../fonts/InterVariable.ttf', import.meta.url)));
const inputs = await Promise.all([[0x41], [0x42, 0x43], [0x44, 0x45, 0x46]].map((u) => subset(src, { unicodes: u })));
const sig = (b) => String.fromCharCode(...b.subarray(0, 4));
const seq = [];
for (const i of inputs) seq.push(new Uint8Array(await wawoff2.compress(i)));
const par = (await Promise.all(inputs.map((i) => wawoff2.compress(i)))).map((r) => new Uint8Array(r));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
console.log(
  'sequential signatures',
  seq.map(sig),
  'lengths',
  seq.map((b) => b.length),
);
console.log(
  'parallel   signatures',
  par.map(sig),
  'lengths',
  par.map((b) => b.length),
  'equal to sequential',
  par.map((b, i) => same(b, seq[i])),
);
const r = wawoff2.compress(inputs[0]);
console.log('compress returns', Object.prototype.toString.call(r), r instanceof Promise ? '(promise)' : '');
