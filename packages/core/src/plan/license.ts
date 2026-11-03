// License gate (§11): read the license from the font's name table, a license file next to it, or
// its package, and decide whether fontphobia may subset it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { nameStrings, parseOs2 } from '../font/tables.ts';

export interface License {
  /** Short id: OFL-1.1, Apache-2.0, Bitstream-Vera, UFL-1.0, MIT, CC0, … or "unknown". */
  id: string;
  open: boolean;
  /** Names a modified version may not use (OFL Reserved Font Names, Vera's "Bitstream"/"Vera"). */
  reserved: string[];
  /** Where the license was found. */
  from: string;
}

const KNOWN: [RegExp, string][] = [
  [/SIL Open Font License|scripts\.sil\.org\/OFL|openfontlicense\.org|\bOFL-1\.[01]\b/i, 'OFL-1.1'],
  [/Apache License|apache\.org\/licenses|\bApache-2\.0\b/i, 'Apache-2.0'],
  [/Ubuntu Font Licen[cs]e|\bUFL-1\.0\b/i, 'UFL-1.0'],
  [/Bitstream Vera|Bitstream, Inc\..*Permission is hereby granted|dejavu[^\n]*License/is, 'Bitstream-Vera'],
  [/\bMIT License\b|\bMIT\b(?=\s*$)/im, 'MIT'],
  [/\bCC0\b|creativecommons\.org\/publicdomain\/zero/i, 'CC0-1.0'],
  [/GNU General Public License.*font exception|GPL-[23]\.0-with-font-exception/is, 'GPL-with-font-exception'],
];

/** OFL: `with Reserved Font Name "Source"`, possibly several: `Reserved Font Names "A" and "B"`. */
function reservedNames(text: string): string[] {
  const out = new Set<string>();
  // Not the license's own definition: `"Reserved Font Name" refers to any names …`.
  for (const m of text.matchAll(/(?<![“"'‘])Reserved\s+Font\s+Names?\s+((?:[“"'‘][^”"'’\n]+[”"'’][\s,]*(?:and\s+|&\s+)?)+)/gi)) {
    for (const n of m[1]!.matchAll(/[“"'‘]([^”"'’]+)[”"'’]/g)) out.add(n[1]!.trim());
  }
  return [...out].sort();
}

function licenseFileNear(file: string, root: string): { text: string; from: string; pkgLicense?: string } | undefined {
  let dir = dirname(file);
  // Up to the package root (node_modules/<pkg> or the project root), nearest first.
  for (let i = 0; i < 6; i++) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* none */ }
    const lic = names.filter((n) => /^(OFL|LICEN[CS]E|COPYING|.*-LICEN[CS]E)(\.(txt|md))?$/i.test(n) || /^.*OFL.*\.txt$/i.test(n)).sort()[0];
    const pkg = names.includes('package.json') ? (() => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).license as string | undefined; } catch { return undefined; } })() : undefined;
    if (lic || pkg) return { text: lic ? readFileSync(join(dir, lic), 'utf8') : '', from: relative(root, join(dir, lic ?? 'package.json')).split(sep).join('/'), pkgLicense: pkg };
    if (dir === root || !dir.startsWith(root) || existsSync(join(dir, 'package.json'))) break;
    dir = dirname(dir);
  }
  return undefined;
}

export function detectLicense(sfnt: Uint8Array, file?: string, root?: string): License {
  const names = nameStrings(sfnt);
  const fromName = [names.get(13), names.get(14)].filter(Boolean).join('\n');
  const copyright = names.get(0) ?? '';
  const near = file && root ? licenseFileNear(file, root) : undefined;
  const sources: [string, string][] = [[fromName, 'name table'], [near?.text ?? '', near?.from ?? ''], [near?.pkgLicense ?? '', near?.from ?? '']];
  for (const [text, from] of sources) {
    if (!text) continue;
    const hit = KNOWN.find(([re]) => re.test(text));
    if (!hit) continue;
    const all = `${copyright}\n${fromName}\n${near?.text ?? ''}`;
    const reserved = new Set(reservedNames(all));
    if (hit[1] === 'Bitstream-Vera') { reserved.add('Bitstream'); reserved.add('Vera'); }
    return { id: hit[1], open: true, reserved: [...reserved].sort(), from };
  }
  return { id: 'unknown', open: false, reserved: reservedNames(`${copyright}\n${fromName}`), from: fromName ? 'name table' : near?.from ?? 'none' };
}

/** Why the face can't be subset, or undefined when it can (§11). */
export function licenseRefusal(sfnt: Uint8Array, lic: License, allowed: boolean): string | undefined {
  const fs = parseOs2(sfnt)?.fsType;
  if (fs?.noSubsetting) return 'OS/2 fsType forbids subsetting (bit 8)';
  if (fs?.embedding === 'restricted') return 'OS/2 fsType is restricted-license embedding (bit 1)';
  if (!lic.open && !allowed) return `license not recognized as open (${lic.from}); add the family to licenses.allow if you have the rights to modify it`;
  return undefined;
}

/** A name without any reserved name in it: "Source Serif 4" with RFN "Source" → "Src Serif 4 Subset". */
export function deriveName(family: string, reserved: string[]): string | undefined {
  const hits = reserved.filter((r) => family.toLowerCase().includes(r.toLowerCase()));
  if (!hits.length) return undefined;
  let out = family;
  for (const r of hits) {
    const short = r[0]! + r.slice(1).replace(/[aeiouAEIOU]/g, '');
    out = out.replace(new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), short === r ? r.slice(0, 3) : short);
  }
  return `${out} Subset`;
}
