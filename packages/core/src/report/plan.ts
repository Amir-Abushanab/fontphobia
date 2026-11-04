// The plan report (§3 "Shape of the default output"): per-face sizes, per-page bytes before and
// after, skipped faces, the shaping repair's cost and every opt-in with its measured saving.
import { codePointsOf, parseUnicodeRange } from '../css/unicode-range.ts';
import type { FacePlan, Plan, UsageFileJson } from '../plan/planner.ts';
import { kb } from './audit.ts';

const label = (f: FacePlan, u: UsageFileJson) => {
  const d = u.faces[f.id]?.descriptors ?? {};
  const parts = [f.family, (d['font-weight'] ?? '400').trim(), (d['font-style'] ?? 'normal').trim()];
  // Slices of one family (fontsource, Google): name them by their source file.
  if (d['unicode-range']) parts.push(`(${f.source?.file.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') ?? f.id})`);
  return parts.join(' ');
};

export interface PageBytes { page: string; now: number; after: number; /** Per face: its own files' bytes now and after. */ faces: Record<string, { now: number; after: number }> }

/** What each page downloads today and with the plan applied (files load per unicode-range). */
export function pageBytes(plan: Plan, usage: UsageFileJson): PageBytes[] {
  const byId = new Map(plan.faces.map((f) => [f.id, f]));
  const sets = new Map<string, { role: string; set: Set<number>; bytes: number; name: string }[]>();
  for (const f of plan.faces) if (f.status === 'planned') sets.set(f.id, (f.files ?? []).map((x) => ({ role: x.role, set: new Set(codePointsOf(parseUnicodeRange(x.unicodeRange))), bytes: x.bytes, name: x.name })));
  return Object.entries(usage.pages).sort(([a], [b]) => (a < b ? -1 : 1)).map(([page, pg]) => {
    let now = 0, after = 0;
    const loaded = new Set<string>();
    const faces: PageBytes['faces'] = {};
    const add = (id: string, k: 'now' | 'after', n: number) => { const x = (faces[id] ??= { now: 0, after: 0 }); x[k] += n; };
    for (const font of pg.fonts) {
      if (font.status >= 400) continue;
      now += font.bytes;
      // Per face: only pages where it draws (a shared file lists every face it backs).
      for (const id of font.faces) if (pg.faces[id]) add(id, 'now', font.bytes);
      // A file stays as it is unless every face it serves is planned.
      if (!font.faces.length || font.faces.some((id) => byId.get(id)?.status !== 'planned')) {
        after += font.bytes;
        for (const id of font.faces) if (pg.faces[id]) add(id, 'after', font.bytes);
        continue;
      }
      for (const id of font.faces) {
        const chars = [...codePointsOf(parseUnicodeRange(pg.faces[id] ?? ''))];
        for (const file of sets.get(id) ?? []) {
          if (loaded.has(file.name) || !chars.some((c) => file.set.has(c))) continue;
          loaded.add(file.name);
          after += file.bytes;
          add(id, 'after', file.bytes);
        }
      }
    }
    return { page, now, after, faces };
  });
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0; };
const pct = (a: number, b: number) => (a ? `${Math.round((1 - b / a) * 100)}%` : '0%');

function table(rows: string[][], align: ('l' | 'r')[]): string[] {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (align[i] === 'r' ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join('  ').trimEnd());
}

export function formatPlan(plan: Plan, usage: UsageFileJson): string {
  const L: string[] = [];
  const planned = plan.faces.filter((f) => f.status === 'planned');
  const pages = pageBytes(plan, usage);
  if (planned.length) {
    const fileBytes = (f: FacePlan, role: string) => { const x = f.files?.find((y) => y.role === role); return x ? kb(x.bytes) : '-'; };
    const perFace = (f: FacePlan) => {
      const ps = pages.map((p) => p.faces[f.id]).filter((x): x is { now: number; after: number } => !!x);
      const now = median(ps.map((p) => p.now)), after = median(ps.map((p) => p.after));
      return `${kb(now)} → ${kb(after)}`;
    };
    L.push(...table([
      ['Face', 'Now', 'Core', 'Ext', 'Rest', 'Median page'],
      ...planned.map((f) => [label(f, usage), kb(f.bytes!.now), fileBytes(f, 'core'), fileBytes(f, 'ext'), fileBytes(f, 'rest'), perFace(f)]),
    ], ['l', 'r', 'r', 'r', 'r', 'r']));
  } else L.push('Nothing to subset.');
  if (pages.length) {
    const now = median(pages.map((p) => p.now)), after = median(pages.map((p) => p.after));
    const max = pages.reduce((m, p) => (p.now - p.after > m.now - m.after ? p : m), pages[0]!);
    L.push('', `Font bytes per page: median ${kb(now)} → ${kb(after)} (${pct(now, after)} less); biggest drop ${max.page} ${kb(max.now)} → ${kb(max.after)}`);
  }
  const repaired = planned.filter((f) => f.repair);
  if (repaired.length) {
    L.push('', 'Shaping repair: characters moved into core so words shape exactly as they did unsplit');
    for (const f of repaired) {
      const cost = f.optIns?.find((o) => o.id === 'split-shaping')?.saving ?? 0;
      const w = f.repair!.words;
      L.push(`  ${label(f, usage)}: ${f.repair!.count} character(s), +${kb(cost)} core; e.g. ${w.slice(0, 4).map((x) => JSON.stringify(x.trim())).join(', ')}`);
    }
  }
  const skipped = plan.faces.filter((f) => f.status !== 'planned');
  if (skipped.length) {
    L.push('', 'Left as they are');
    for (const f of skipped) L.push(`  ${label(f, usage)}: ${f.status === 'refused' ? 'refused, ' : ''}${f.reason}`);
  }
  const renames = planned.filter((f) => f.license?.rename);
  if (renames.length) {
    L.push('', 'Renamed inside the font (the license reserves the name; CSS font-family unchanged)');
    for (const f of renames) L.push(`  ${f.license!.rename!.from} → ${f.license!.rename!.to}`);
  }
  const offered = plan.optIns.filter((o) => !o.applied && o.saving > 0);
  if (offered.length) {
    L.push('', 'Opt-ins (would change rendering, not applied):');
    for (const o of offered) {
      const ex = planned.flatMap((f) => f.optIns?.filter((x) => x.id === o.id) ?? [])[0]!;
      L.push(`  ${o.id.padEnd(14)} saves ${kb(o.saving).padStart(8)}  ${ex.change}${o.faces > 1 ? ` (${o.faces} faces)` : ''}`);
    }
  }
  const applied = plan.optIns.filter((o) => o.applied);
  if (applied.length) L.push('', `Applied opt-ins: ${applied.map((o) => `${o.id} (saves ${kb(o.saving)})`).join(', ')}`);
  const notes = [...new Set(planned.flatMap((f) => (f.notes ?? []).filter((n) => !n.startsWith('no TrueType')).map((n) => `${f.family}: ${n}`)))];
  if (notes.length) { L.push('', 'Notes'); for (const n of notes) L.push(`  ${n}`); }
  return L.join('\n');
}
