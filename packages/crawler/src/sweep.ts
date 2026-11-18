// The sampled sweep. Every page is loaded once at the first viewport; the other widths and the
// default-font-size sweep (§7.2) run in full only on a few sample pages of each section. A setting
// then runs on the section's other pages only when, on a sample page, it drew something that page's
// first load didn't. Pages of one section share their templates and CSS, so the text a width or a
// larger default font size reveals (a mobile menu, a heading's other weight) is the same on each.
//
// On principlestash.com (59 pages, 15 loads each), loading every page once gave the same plan as all
// 885 loads: every file, unicode-range and size.
import { buildUsage, canonicalJson, usageToJson, type FontFacts, type Visit } from '@fontphobia/core';

/** Sample pages per section that get every width and font size. */
export const SWEEP_SAMPLE = 2;

/** The section a page belongs to: its parent path, and what decides which settings it gets. */
export function sectionOf(page: string, traits: { emMq: boolean; textScale: boolean; private: boolean }): string {
  const path = page.split('?')[0]!.replace(/\/+$/, '');
  const parent = path.slice(0, path.lastIndexOf('/') + 1) || '/';
  return [parent, page.includes('?') ? '?' : '', traits.emMq, traits.textScale, traits.private].join('\u0000');
}

/** A load setting, as a key: viewport, default font size, OS text scale. */
export const settingKey = (s: { viewport: number; fontSize: number; textScale?: number }) =>
  `${s.viewport}@${s.fontSize}${s.textScale ? `x${s.textScale}` : ''}`;

/**
 * What the plan reads from a page's loads: per face, its characters, features, weights and axis
 * values (optical size and font size aside: they follow the default font size the sweep changes),
 * and per page, the characters each face and each fallback draws and the font files that loaded.
 * Built from the loads by the same matching as usage.json, so text drawn by another element in the
 * same face, or letter-spacing that scales with the font size, is not counted as new.
 */
export function planFingerprint(visits: Visit[], facts: Map<string, FontFacts>): string {
  const u = usageToJson(buildUsage(visits, facts, { maxWords: 0 }), {} as never);
  const settled = (x: { size?: unknown; axes?: Record<string, unknown> } | undefined) => {
    if (!x) return x;
    const { size: _size, axes, ...rest } = x;
    const { opsz: _opsz, ...kept } = axes ?? {};
    return { ...rest, axes: kept };
  };
  return canonicalJson({
    faces: Object.fromEntries(
      Object.entries(u.faces).map(([id, f]) => [
        id,
        { chars: f.chars, features: f.features, rendered: settled(f.rendered), declared: settled(f.declared) },
      ]),
    ),
    pages: Object.fromEntries(
      Object.entries(u.pages).map(([p, pg]) => [
        p,
        { faces: pg.faces, fallback: pg.fallback, fonts: pg.fonts.map((x) => x.url ?? x.sha256) },
      ]),
    ),
  });
}
