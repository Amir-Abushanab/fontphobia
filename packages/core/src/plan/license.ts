// License gate (§11): read the license from the font's name table, a license file next to it, or
// its package, and decide whether fontphobia may subset it.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
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

/**
 * OFL Reserved Font Names after the copyright: `with Reserved Font Name "Source"`, `Name: "League Gothic"`, `Name < Fira >`,
 * unquoted `Name Anonymous Pro.` (to the sentence's end or the line's), several: `Names "A" and "B"`, `A, B & C`.
 */
function reservedNames(text: string): string[] {
  const out = new Set<string>();
  // Not the license's own sentences: `"Reserved Font Name" refers to …`, `may use the Reserved Font Name(s) unless …`.
  for (const m of text.matchAll(/(?<![“"'‘])\bReserved\s+Font\s+Names?(?!\s*\()[ \t]*:?/gi)) {
    let rest = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    // Quoted or <bracketed> names may start on the next line; unquoted ones start with a capital or digit on this one.
    for (let n; (n = /^(?:\s*[“"'‘]([^”"'’\n]+)[”"'’]|\s*<([^>\n]+)>|[ \t]*([\p{Lu}\d][^,;&()<>“”"‘’\n]*?)(?=[ \t]+and[ \t]|[ \t]*[,;&()]|\.(?:\s|$)|[ \t]*(?:\r?\n|$)))/u.exec(rest));) {
      const name = (n[1] ?? n[2] ?? n[3])!.trim();
      if (name && name.length <= 64) out.add(name);
      const joiner = /^[ \t]*(?:,[ \t]*(?:and\b|&)?|and\b|&)/.exec(rest.slice(n[0].length));
      if (!joiner) break;
      rest = rest.slice(n[0].length + joiner[0].length);
    }
  }
  return [...out].toSorted();
}

/** The font's own family: name ID 16, else 1. */
export function fontFamily(sfnt: Uint8Array): string | undefined {
  const names = nameStrings(sfnt);
  return names.get(16) ?? names.get(1);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The license files in one directory that describe this font, best first: `<Name>-LICENSE` or `<Name>-OFL.txt` where
 * <Name> starts the font's file name or family (longest first), then `OFL*.txt`, then, only when `generic`, LICENSE/COPYING.
 */
function licenseFiles(names: string[], keys: string[], generic: boolean): string[] {
  const named: [number, string][] = [], ofl: string[] = [], plain: string[] = [];
  for (const n of names) {
    if (/^(LICEN[CS]E|COPYING)(\.(txt|md))?$/i.test(n)) { if (generic) plain.push(n); continue; }
    if (/^OFL.*\.txt$/i.test(n)) { ofl.push(n); continue; }
    const m = /^(.+?)[-_ ](?:LICEN[CS]E(?:\.(?:txt|md))?|OFL.*\.txt)$/i.exec(n) ?? /^(.+?)OFL.*\.txt$/i.exec(n);
    if (!m) continue;
    const k = norm(m[1]!);
    if (/^(sil|licen[cs]e)$/.test(k) && /OFL/i.test(n)) ofl.push(n); // SIL-OFL.txt, LICENSE-OFL.txt: no family named
    else if (k && keys.some((x) => x.startsWith(k))) named.push([k.length, n]);
  }
  const by = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return [...named.toSorted((a, b) => b[0] - a[0] || by(a[1], b[1])).map((x) => x[1]), ...ofl.toSorted(by), ...plain.toSorted(by)];
}

/**
 * The license file that describes this font, nearest first (§11). Up from the font's directory to the project root, a
 * workspace package's root (a package.json outside node_modules), or the font's package root in node_modules
 * (node_modules/<pkg>, node_modules/@scope/<pkg>). At a project or workspace root only font-specific files count: its
 * LICENSE and package.json are the project's. In node_modules, LICENSE and package.json's `license` are the font's.
 */
function licenseFileNear(file: string, root: string, family?: string): { text: string; from: string; pkgLicense?: string } | undefined {
  const keys = [basename(file).replace(/\.[^.]+$/, ''), family ?? ''].map(norm).filter(Boolean);
  const parts = file.split(sep), nm = parts.lastIndexOf('node_modules');
  const end = nm + (parts[nm + 1]?.startsWith('@') ? 3 : 2);
  const pkgRoot = nm >= 0 && end < parts.length ? parts.slice(0, end).join(sep) : undefined;
  let dir = dirname(file);
  for (let i = 0; i < 8; i++) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* none */ }
    const inPkg = pkgRoot !== undefined && (dir === pkgRoot || dir.startsWith(pkgRoot + sep));
    const top = !inPkg && (dir === root || names.includes('package.json'));
    const lic = licenseFiles(names, keys, !top)[0];
    const pkg = inPkg && names.includes('package.json') ? (() => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).license as string | undefined; } catch { return undefined; } })() : undefined;
    if (lic || pkg) return { text: lic ? readFileSync(join(dir, lic), 'utf8') : '', from: relative(root, join(dir, lic ?? 'package.json')).split(sep).join('/'), pkgLicense: typeof pkg === 'string' ? pkg : undefined };
    if (inPkg ? dir === pkgRoot : top || !dir.startsWith(root + sep)) break;
    dir = dirname(dir);
  }
  return undefined;
}

export function detectLicense(sfnt: Uint8Array, file?: string, root?: string): License {
  const names = nameStrings(sfnt);
  const fromName = [names.get(13), names.get(14)].filter(Boolean).join('\n');
  const copyright = names.get(0) ?? '';
  const near = file && root ? licenseFileNear(file, root, names.get(16) ?? names.get(1)) : undefined;
  const sources: [string, string][] = [[fromName, 'name table'], [near?.text ?? '', near?.from ?? ''], [near?.pkgLicense ?? '', near?.from ?? '']];
  for (const [text, from] of sources) {
    if (!text) continue;
    const hit = KNOWN.find(([re]) => re.test(text));
    if (!hit) continue;
    const all = `${copyright}\n${fromName}\n${near?.text ?? ''}`;
    const reserved = new Set(reservedNames(all));
    if (hit[1] === 'Bitstream-Vera') { reserved.add('Bitstream'); reserved.add('Vera'); }
    return { id: hit[1], open: true, reserved: [...reserved].toSorted(), from };
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

/**
 * The internal rename (§11), decided from the font's own family, which is where a reserved name has to go, whatever the
 * CSS calls it. `rename` config matches the CSS family or the font's. The CSS font-family never changes.
 */
export function renameFor(sfnt: Uint8Array, cssFamily: string, reserved: string[], rename: Record<string, string> = {}): { from: string; to: string } | undefined {
  const own = fontFamily(sfnt) ?? cssFamily;
  const pick = (k: string) => (Object.hasOwn(rename, k) ? rename[k] : undefined);
  const to = pick(cssFamily) ?? pick(own) ?? deriveName(own, reserved);
  return to ? { from: own, to } : undefined;
}
