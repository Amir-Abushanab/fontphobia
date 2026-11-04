// `fontphobia apply-kit` (§6.6): the kit settings the Typekit API can change, after a confirmation.
// TYPEKIT_TOKEN from fonts.adobe.com/account/tokens. TYPEKIT_API / TYPEKIT_CSS override the endpoints (tests).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkLiveKit, desiredWeights, getKit, getPublishedKit, sameFamilies, isTypekitSheet, kitIdOf, manifestJson, MANIFEST_FILE, MANIFEST_VERSION, plannedFamilies, planKit, readManifest, repoText, setKitFamilies,
  harfbuzzVersion, type KitApi, type KitUsageFace, type Manifest, type UsageFileJson,
} from '@fontphobia/core';

const api = (): KitApi | string => {
  const token = process.env.TYPEKIT_TOKEN;
  if (!token) return 'set TYPEKIT_TOKEN (an API token from fonts.adobe.com/account/tokens)';
  return { token, base: process.env.TYPEKIT_API };
};

function kitFaces(usage: UsageFileJson): Map<string, KitUsageFace[]> {
  const out = new Map<string, KitUsageFace[]>();
  for (const f of Object.values(usage.faces)) {
    const kit = isTypekitSheet(f.sheet) ? kitIdOf(f.sheet!) : undefined;
    if (kit) (out.get(kit) ?? out.set(kit, []).get(kit)!).push(f);
  }
  return out;
}

export async function applyKit(root: string, usage: UsageFileJson, o: { yes?: boolean; check?: boolean; ask: (q: string) => Promise<boolean>; interactive: boolean; version: string; log: (s: string) => void }): Promise<number> {
  const kits = kitFaces(usage);
  if (!kits.size) { o.log('No Adobe Fonts kit draws text on the audited pages.'); return 0; }
  if (o.check) {
    let bad = 0;
    for (const [kit, faces] of kits) {
      const p = await checkLiveKit(kit, faces, { cssBase: process.env.TYPEKIT_CSS });
      o.log(p.length ? `kit ${kit}:\n${p.map((x) => `  ${x}`).join('\n')}` : `kit ${kit}: every face and character the pages use is served`);
      bad += p.length;
    }
    return bad ? 1 : 0;
  }
  const a = api();
  if (typeof a === 'string') { o.log(`apply-kit: ${a}`); return 1; }
  const desired = desiredWeights(repoText(root));
  const plans = [];
  for (const [kit, faces] of kits) {
    const draft = await getKit(a, kit);
    // Unpublished edits in the draft would go live with ours: refuse instead.
    const live = await getPublishedKit(a, kit);
    if (!sameFamilies(draft, live)) { o.log(`kit ${kit}: its draft has unpublished changes on fonts.adobe.com; publish or discard them first (fontphobia publishes the whole draft)`); return 1; }
    const p = planKit(kit, draft, faces, desired);
    plans.push(p);
    if (!p.changes.length) { o.log(`kit ${kit}: nothing to change`); continue; }
    o.log(`kit ${kit}:`);
    for (const c of p.changes) {
      o.log(`  ${c.name}: variations ${c.variations[0].join(',')} → ${c.variations[1].join(',')} (${c.why.join('; ')})`);
    }
  }
  const todo = plans.filter((p) => p.changes.length);
  if (!todo.length) return 0;
  o.log('\nThis publishes the kit: every site that uses it changes, including pages the audit didn\'t see.');
  o.log('Each change is read back from Adobe before it is published; `fontphobia revert` restores the kit.');
  if (!o.yes) {
    if (!o.interactive) { o.log('Not applied: rerun with --yes to apply without asking.'); return 1; }
    if (!(await o.ask('Apply and publish? (y/N) '))) { o.log('Not applied.'); return 1; }
  }
  const prev = readManifest(root);
  const m: Manifest = prev ?? { version: MANIFEST_VERSION, fontphobia: o.version, harfbuzz: harfbuzzVersion(), chrome: usage.meta.chrome, entries: {} };
  for (const p of todo) {
    const applied = plannedFamilies(p);
    await setKitFamilies(a, p.kit, applied, { expectDraft: p.families });
    const earlier = m.kits?.find((k) => k.kit === p.kit);
    const previous = earlier?.previous ?? p.families.map((f) => ({ id: f.id, variations: f.variations, subset: f.subset }));
    m.kits = [...(m.kits ?? []).filter((k) => k.kit !== p.kit), { kit: p.kit, previous, applied }].sort((x, y) => (x.kit < y.kit ? -1 : 1));
    o.log(`kit ${p.kit}: published.`);
  }
  writeFileSync(join(root, MANIFEST_FILE), manifestJson(m));
  o.log(`Recorded the previous settings in ${MANIFEST_FILE}; \`fontphobia revert\` restores them.\nAdobe's CDN can take a few minutes; then \`fontphobia apply-kit --check\` confirms the live kit serves every face and character the pages use.`);
  return 0;
}

/**
 * Restore each kit's previous families (revert). Returns problems. Only over what fontphobia
 * published: later edits on fonts.adobe.com aren't undone silently. A kit already back to its
 * previous settings (restored by hand) counts as restored. `keep`: leave every kit as it is.
 */
export async function revertKits(root: string, log: (s: string) => void, o: { keep?: boolean } = {}): Promise<string[]> {
  const m = readManifest(root);
  if (!m?.kits?.length) return [];
  if (o.keep) {
    for (const k of m.kits) log(`kit ${k.kit}: left as it is (--keep-kits)`);
    delete m.kits; writeFileSync(join(root, MANIFEST_FILE), manifestJson(m));
    return [];
  }
  const a = api();
  if (typeof a === 'string') return [`kit ${m.kits.map((k) => k.kit).join(', ')}: ${a} to restore ${m.kits.length > 1 ? 'them' : 'it'}`];
  const problems: string[] = [];
  const done = new Set<string>();
  for (const k of m.kits) {
    try {
      const [draft, live] = [await getKit(a, k.kit), await getPublishedKit(a, k.kit)];
      if (sameFamilies(draft, k.previous) && sameFamilies(live, k.previous)) { log(`kit ${k.kit}: already has its previous settings`); done.add(k.kit); continue; }
      if (!sameFamilies(draft, k.applied) || !sameFamilies(live, k.applied)) {
        const add = k.previous.flatMap((p) => {
          const now = draft.find((f) => f.id === p.id);
          const gone = p.variations.filter((v) => !now?.variations.includes(v));
          return gone.length ? [`${now?.name ?? p.id} ${gone.join(', ')}`] : [];
        });
        const keep = '`fontphobia revert --keep-kits` keeps the kit as it is';
        problems.push(`kit ${k.kit} was edited on fonts.adobe.com after fontphobia published it, so revert leaves it alone. ${add.length ? `To restore it, add back ${add.join('; ')} there and publish, then run revert again; or ${keep}` : `Every style fontphobia removed is back, alongside other edits: ${keep}`}`);
        continue;
      }
      await setKitFamilies(a, k.kit, k.previous, { expectDraft: k.applied });
      log(`kit ${k.kit}: previous settings restored and published`);
      done.add(k.kit);
    } catch (e) { problems.push(`kit ${k.kit}: ${(e as Error).message}`); }
  }
  // Kits restored so far aren't restored again on the next run.
  m.kits = m.kits.filter((k) => !done.has(k.kit));
  if (!m.kits.length) delete m.kits;
  writeFileSync(join(root, MANIFEST_FILE), manifestJson(m));
  return problems;
}

export const readUsage = (root: string, file?: string): UsageFileJson | undefined => {
  const f = join(root, file ?? '.fontphobia/usage.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as UsageFileJson) : undefined;
};
