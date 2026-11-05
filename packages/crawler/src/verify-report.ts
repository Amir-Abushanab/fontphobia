// `verify` (§10): run the deterministic layers, then the browser layer, and report.
import { relative } from 'node:path';
import { kb, readManifest, verifyStatic, type StaticVerify } from '@fontphobia/core';
import { verifyBrowser, type BrowserVerify, type Comparison, type VerifyOptions } from './verify.ts';

export interface VerifyResult {
  static: Omit<StaticVerify, 'outputs'> & { outputs: number };
  browser?: BrowserVerify;
  ok: boolean;
}

export async function verify(o: Omit<VerifyOptions, 'manifest' | 'staticResult'> & { browser?: boolean }): Promise<VerifyResult> {
  const manifest = readManifest(o.root);
  if (!manifest || !Object.keys(manifest.entries).length) throw new Error('.fontphobia/manifest.json has no entries: nothing to verify. Run `fontphobia build --write` first.');
  const log = o.log ?? (() => {});
  log(`checking ${Object.values(manifest.entries).reduce((n, e) => n + e.outputs.length, 0)} output(s) and shaping…`);
  const st = await verifyStatic(o.root, o.usage, manifest);
  const browser = o.browser === false ? undefined : await verifyBrowser({ ...o, manifest, staticResult: st });
  return { static: { ...st, outputs: st.outputs.size }, browser, ok: st.ok && (browser?.ok ?? true) };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0; };
const where = (c: Comparison) => `${c.page} @${c.viewport}px DPR ${c.dpr}${c.browser !== 'chromium' ? ` ${c.browser}` : ''}`;

function lines(r: VerifyResult, root: string, md: boolean): string[] {
  const L: string[] = [];
  const h = (t: string) => L.push('', md ? `### ${t}` : t);
  const item = (t: string) => L.push(md ? `- ${t}` : `  ${t}`);
  const st = r.static;
  const outputsOk = !st.findings.some((f) => f.kind === 'output' || f.kind === 'css' || f.kind === 'source');
  h('Font files and CSS');
  item(outputsOk ? `${st.outputs} output file(s): bytes match the manifest, they decode and validate, and the CSS loads them with the original descriptors` : 'problems below');
  h('Shaping equivalence');
  for (const s of st.shaping) {
    const extra = s.rounding ? `, ${s.rounding} within limit-axes rounding (outlines ≤ ${s.maxPointDelta?.toFixed(1)} units, advances ≤ ${s.maxAdvanceDelta})` : '';
    item(`${s.id}: ${s.words} word(s), ${s.cases} case(s): ${s.identical} identical${extra}${s.regressions ? `, **${s.regressions} differ**` : ''}`);
  }
  const bad = st.findings.filter((f) => f.severity === 'regression');
  const warn = st.findings.filter((f) => f.severity === 'warning');
  for (const f of bad) item(`regression: ${f.id}: ${f.message}`);
  for (const f of warn) item(`warning: ${f.id}: ${f.message}`);

  const b = r.browser;
  if (b) {
    h(b.baseline === 'worktree' ? 'In the browser ("before" is HEAD built in a git worktree)' : 'In the browser ("before" is this build with the original fonts swapped back)');
    const count = (k: string) => b.comparisons.filter((c) => c.class === k).length;
    item(`${b.browsers.map((x) => `${x.engine} ${x.version}`).join(', ')} · ${b.pages.length} page(s)${b.skipped ? ` (set cover; ${b.skipped} more not visited)` : ''} · ${b.comparisons.length} comparison(s): ${count('identical')} identical, ${count('sub-pixel rounding')} sub-pixel rounding, ${count('regression')} regression(s)${count('unrelated') ? `, ${count('unrelated')} with pixel noise in text fontphobia didn't touch` : ''}${count('flaky') ? `, ${count('flaky')} flaky (a pixel difference that didn't reproduce)` : ''}${count('content changed') ? `, ${count('content changed')} content changed (left out)` : ''}${count('failed') ? `, ${count('failed')} failed to load` : ''}`);
    for (const c of b.comparisons.filter((x) => x.class === 'regression' || x.class === 'failed')) {
      item(`${c.class}: ${where(c)}: ${c.causes.join('; ')}${c.moved ? ` (${c.moved} of ${c.nodes} text boxes moved, up to ${c.maxDx} px)` : ''}${c.pixels ? `, ${c.pixels} px differ` : ''}`);
      for (const e of c.examples.slice(0, 3)) if (e.text) L.push(md ? `  - ${e.text}: ${e.cause}` : `      ${e.text}: ${e.cause}`);
      if (c.diffImage) L.push(md ? `  - diff: \`${relative(root, c.diffImage)}\`` : `      diff: ${relative(root, c.diffImage)}`);
    }
    for (const c of b.comparisons.filter((x) => x.class === 'unrelated').slice(0, 5)) item(`unrelated: ${where(c)}: ${c.causes.join('; ')}`);
    for (const c of b.comparisons.filter((x) => x.class === 'flaky').slice(0, 5)) item(`flaky: ${where(c)}: ${c.causes.join('; ')}`);
    for (const c of b.comparisons.filter((x) => x.class === 'sub-pixel rounding').slice(0, 5)) item(`sub-pixel rounding: ${where(c)}: text boxes moved up to ${c.maxDx} px, no line or height changes`);
    for (const x of b.rejected) item(`regression: ${x.browser} rejects ${x.file}: ${x.error}`);
    for (const x of b.loads) item(`regression: ${x.page}: ${x.problem}`);

    h('Font bytes per page');
    if (b.bytes.length) {
      const now = median(b.bytes.map((p) => p.before.bytes)), after = median(b.bytes.map((p) => p.after.bytes));
      item(`median ${kb(now)} → ${kb(after)}${now ? ` (${Math.round((1 - after / now) * 100)}% less)` : ''}`);
      if (md) L.push('', '| Page | Before | After | Requests |', '|---|---:|---:|---:|');
      for (const p of b.bytes) L.push(md ? `| ${p.page} | ${kb(p.before.bytes)} | ${kb(p.after.bytes)} | ${p.before.requests} → ${p.after.requests} |` : `  ${p.page.padEnd(30)} ${kb(p.before.bytes).padStart(9)} → ${kb(p.after.bytes).padStart(9)}  (${p.before.requests} → ${p.after.requests} requests)`);
      if (md) L.push('');
      item(b.loads.length ? 'some files loaded where they weren\'t needed (above)' : 'every extended and rest file loaded only on pages that use one of its characters');
    }
  }
  L.push('', r.ok ? 'Verify passed: no differences.' : `Verify failed. ${b ? `Diff images are in ${relative(root, b.comparisons.find((c) => c.diffImage)?.diffImage?.replace(/[/\\][^/\\]+$/, '') ?? '.fontphobia/verify') || '.'}. ` : ''}\`fontphobia revert\` restores the original fonts.`);
  L.push(md ? '\nRerun with `fontphobia verify`.' : '');
  return L;
}

export function formatVerify(r: VerifyResult, root: string): string {
  return lines(r, root, false).join('\n').replace(/^\n/, '').replace(/\*\*/g, '');
}

export const VERIFY_BEGIN = '<!-- fontphobia:verify -->';
export const VERIFY_END = '<!-- /fontphobia:verify -->';

/** The verify section of report.md, replacing an earlier one. */
export function verifyMarkdown(report: string, r: VerifyResult, root: string): string {
  const section = [VERIFY_BEGIN, '## Verify', ...lines(r, root, true), VERIFY_END].join('\n');
  const a = report.indexOf(VERIFY_BEGIN), b = report.indexOf(VERIFY_END);
  if (a >= 0 && b > a) return report.slice(0, a) + section + report.slice(b + VERIFY_END.length);
  return report.replace(/\n*$/, '\n\n') + section + '\n';
}
