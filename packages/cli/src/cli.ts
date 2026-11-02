#!/usr/bin/env node
// fontphobia CLI. M1 ships `inspect` and the low-level `subset`; the rest arrives in M2–M6.
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { cac } from 'cac';
import {
  formatInspection, formatUnicodeRange, harfbuzzVersion, inspectFont, parseUnicodeRange, rangesFromCodePoints, subsetFont,
  codePointsOf, type AxisSetting, type SubsetOptions,
} from '@fontphobia/core';
import pkg from '../package.json' with { type: 'json' };

const cli = cac('fontphobia');

cli
  .command('inspect <font>', "Show a font's tables, axes, features, hinting and sizes")
  .option('--json', 'Machine-readable output')
  .action(async (file: string, o: { json?: boolean }) => {
    const info = await inspectFont(new Uint8Array(readFileSync(file)));
    process.stdout.write((o.json ? JSON.stringify(info, null, 2) : formatInspection(info)) + '\n');
  });

cli
  .command('subset <font>', 'Low-level: subset one font to a validated WOFF2 (no crawl, no CSS edits)')
  .option('-o, --output <file>', 'Output file (.woff2)')
  .option('--unicodes <ranges>', 'Code points to keep, e.g. "U+20-7E,U+A0-FF" (default: all)')
  .option('--text <text>', 'Also keep the characters of this text')
  .option('--features <list>', '"default" (HarfBuzz defaults), "*", "+tnum,+ss01" (defaults plus these) or "kern,liga" (only these)', { default: 'default' })
  .option('--name-ids <list>', 'name IDs to keep, or "*" (default 0-6,13,14,16,17,25)')
  .option('--axis <tag=value>', 'Pin an axis (wght=400) or limit it (wght=400:700). Changes widths slightly (PLAN §8.6). Repeatable')
  .option('--no-hinting', 'Drop TrueType hinting (changes rendering on Windows and Linux; PLAN §8.8)')
  .action(async (file: string, o: { output?: string; unicodes?: string; text?: string; features: string; nameIds?: string; axis?: string | string[]; hinting: boolean }) => {
    if (!o.output) throw new Error('--output is required');
    if (extname(o.output) !== '.woff2') throw new Error('--output must end in .woff2');
    const opts: SubsetOptions = { unicodes: '*', hinting: o.hinting };
    if (o.unicodes || o.text) {
      const cps = new Set<number>(o.unicodes ? codePointsOf(parseUnicodeRange(o.unicodes)) : []);
      for (const ch of o.text ?? '') cps.add(ch.codePointAt(0)!);
      opts.unicodes = cps;
    }
    const f = o.features.trim();
    if (f === '*') opts.features = '*';
    else if (f !== 'default') {
      const tags = f.split(',').map((t) => t.trim()).filter(Boolean);
      opts.features = tags.every((t) => t.startsWith('+')) ? { add: tags.map((t) => t.slice(1)) } : { only: tags };
    }
    if (o.nameIds) opts.nameIds = o.nameIds === '*' ? '*' : o.nameIds.split(',').map(Number);
    for (const a of [o.axis ?? []].flat()) {
      const m = a.match(/^([\x20-\x7e]{4})=(-?[\d.]+)(?::(-?[\d.]+))?$/);
      if (!m) throw new Error(`Bad --axis ${JSON.stringify(a)}; use wght=400 or wght=400:700`);
      const v: AxisSetting = m[3] === undefined ? Number(m[2]) : { min: Number(m[2]), max: Number(m[3]) };
      (opts.axes ??= {})[m[1]!] = v;
    }
    const src = new Uint8Array(readFileSync(file));
    const r = await subsetFont(src, opts);
    writeFileSync(o.output, r.woff2);
    const pct = ((1 - r.woff2.byteLength / src.byteLength) * 100).toFixed(1);
    process.stdout.write(`${o.output}: ${r.woff2.byteLength} bytes (${pct}% smaller than the source), ${r.unicodes.length} characters\nunicode-range: ${formatUnicodeRange(rangesFromCodePoints(r.unicodes))}\n`);
  });

cli.help();
cli.version(`${pkg.version} (HarfBuzz ${harfbuzzVersion()})`);

try {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand && !process.argv.slice(2).some((a) => ['-h', '--help', '-v', '--version'].includes(a))) cli.outputHelp();
  else await cli.runMatchedCommand();
} catch (e) {
  process.stderr.write(`fontphobia: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
