// `revert` (§9): put every original @font-face and preload back from the manifest, byte for byte.
// The generated fonts stay; the result lists them for you to delete.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBlock } from './css.ts';
import { MANIFEST_FILE, readManifest, removeManifest } from './manifest.ts';

export interface RevertResult {
  files: string[];
  fonts: string[];
  problems: string[];
  /** Generated stylesheets removed. */ removed: string[];
}

export function revertProject(root: string, o: { write?: boolean } = {}): RevertResult {
  const m = readManifest(root);
  if (!m) throw new Error(`No ${MANIFEST_FILE} in ${root}; nothing to revert`);
  const texts = new Map<string, string>();
  const read = (f: string) => {
    let t = texts.get(f);
    if (t === undefined) {
      t = readFileSync(join(root, f), 'utf8');
      texts.set(f, t);
    }
    return t;
  };
  const problems: string[] = [];
  const touched = new Set<string>();
  const deleted: string[] = [];
  // Font readiness checks given the page's text: each call back as it was.
  for (const fc of m.fontChecks ?? []) {
    if (!existsSync(join(root, fc.file))) {
      problems.push(`${fc.file} is gone (a document.fonts call fontphobia changed)`);
      continue;
    }
    const t = read(fc.file);
    const at = t.indexOf(fc.to);
    if (at < 0) {
      problems.push(
        `the document.fonts call fontphobia changed in ${fc.file} changed since; put the original back yourself:\n${fc.from}`,
      );
      continue;
    }
    texts.set(fc.file, t.slice(0, at) + fc.from + t.slice(at + fc.to.length));
    touched.add(fc.file);
  }
  // fontsource ejects (§6.2): imports back to the package; the generated copy goes if unchanged.
  for (const [file, ej] of Object.entries(m.ejects ?? {}).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    // next/font/google and Astro ejects: each rewritten snippet back.
    for (const sn of ej.snippets ?? []) {
      if (!existsSync(join(root, sn.file))) {
        problems.push(`${sn.file} is gone (eject of ${ej.package})`);
        continue;
      }
      const t = read(sn.file);
      const at = t.indexOf(sn.to);
      if (at < 0) {
        problems.push(
          `what fontphobia wrote in ${sn.file} for ${ej.package} changed since; put the original back yourself:\n${sn.from}`,
        );
        continue;
      }
      texts.set(sn.file, t.slice(0, at) + sn.from + t.slice(at + sn.to.length));
      touched.add(sn.file);
    }
    for (const i of ej.imports) {
      if (!existsSync(join(root, i.file))) {
        problems.push(`${i.file} is gone (import of ${ej.specifier})`);
        continue;
      }
      const t = read(i.file);
      const m2 = new RegExp(`(["'])${i.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`).exec(t);
      if (!m2) {
        problems.push(`the import of ${i.to} is gone from ${i.file}`);
        continue;
      }
      texts.set(i.file, t.slice(0, m2.index + 1) + i.from + t.slice(m2.index + 1 + i.to.length));
      touched.add(i.file);
    }
    if (existsSync(join(root, file))) {
      if (
        createHash('sha256')
          .update(readFileSync(join(root, file)))
          .digest('hex') === ej.sha256
      )
        deleted.push(file);
      else problems.push(`${file} was edited after the build; delete it yourself once nothing imports it`);
    }
  }
  for (const e of Object.values(m.entries).toSorted((a, b) => (a.id < b.id ? -1 : 1))) {
    if (m.ejects?.[e.stylesheet]) continue; // the whole copy goes
    if (e.next) {
      // next/font/local: the call's path string back.
      if (!existsSync(join(root, e.next.file))) {
        problems.push(`${e.next.file} is gone (${e.id})`);
        continue;
      }
      const t = read(e.next.file);
      const q = new RegExp(`(["'])${e.next.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`).exec(t);
      if (!q) {
        problems.push(`the path ${e.next.to} is gone from ${e.next.file}`);
        continue;
      }
      texts.set(e.next.file, t.slice(0, q.index + 1) + e.next.from + t.slice(q.index + 1 + e.next.to.length));
      touched.add(e.next.file);
      continue;
    }
    if (!existsSync(join(root, e.stylesheet))) {
      problems.push(`${e.stylesheet} is gone (${e.id})`);
      continue;
    }
    const text = read(e.stylesheet);
    const span = findBlock(text, e.id);
    if (!span) {
      problems.push(`no fontphobia block for ${e.id} in ${e.stylesheet}`);
      continue;
    }
    texts.set(e.stylesheet, text.slice(0, span.start) + e.declaration + text.slice(span.end));
    touched.add(e.stylesheet);
    for (const p of e.preloads ?? []) {
      if (!existsSync(join(root, p.file))) {
        problems.push(`${p.file} is gone (preload of ${e.id})`);
        continue;
      }
      const t = read(p.file);
      const at = t.indexOf(p.to);
      if (at < 0) {
        problems.push(`preload ${p.to} not found in ${p.file}`);
        continue;
      }
      texts.set(p.file, t.slice(0, at) + p.from + t.slice(at + p.to.length));
      touched.add(p.file);
    }
  }
  // next/font/google: each call's options back.
  for (const r of m.options ?? []) {
    if (!existsSync(join(root, r.file))) {
      problems.push(`${r.file} is gone (${r.family} next/font/google call)`);
      continue;
    }
    const t = read(r.file);
    const at = t.indexOf(r.to);
    if (at < 0) {
      problems.push(`the ${r.family} call fontphobia narrowed in ${r.file} changed since; put back ${r.from} yourself`);
      continue;
    }
    texts.set(r.file, t.slice(0, at) + r.from + t.slice(at + r.to.length));
    touched.add(r.file);
  }
  // google-fonts tighten: the original stylesheet URLs back (after the self-host copy's link, if any, went back to the tightened URL).
  for (const r of m.google ?? []) {
    for (const f of r.files) {
      if (!existsSync(join(root, f))) {
        problems.push(`${f} is gone (Google Fonts URL)`);
        continue;
      }
      let t = read(f);
      let n = 0;
      const amp = (u: string) => u.replace(/&/g, '&amp;');
      for (const [to, from] of r.to.includes('&')
        ? [
            [amp(r.to), amp(r.from)],
            [r.to, r.from],
          ]
        : [[r.to, r.from]]) {
        const parts = t.split(to!);
        n += parts.length - 1;
        t = parts.join(from!);
      }
      if (!n) {
        problems.push(`the Google Fonts URL ${r.to} is gone from ${f}`);
        continue;
      }
      texts.set(f, t);
      touched.add(f);
    }
  }
  if (o.write) {
    for (const f of touched) writeFileSync(join(root, f), texts.get(f)!);
    for (const f of deleted) unlinkSync(join(root, f));
    if (!problems.length) removeManifest(root);
  }
  const fonts = [
    ...new Set([
      ...Object.values(m.entries).flatMap((e) => e.outputs.map((x) => x.file)),
      ...Object.values(m.ejects ?? {}).flatMap((e) => e.files ?? []),
    ]),
  ]
    .filter((f) => existsSync(join(root, f)))
    .toSorted();
  return { files: [...touched].toSorted(), fonts, problems, removed: deleted.toSorted() };
}
