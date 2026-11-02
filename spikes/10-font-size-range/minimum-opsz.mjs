// Follow-up to sizes.mjs part C: with a minimum font size set, which size does
// `font-optical-sizing: auto` use? Tests text below, at and above the minimum,
// under different default sizes.
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const font = readFileSync(new URL('./font/inter-opsz-wght-latin.woff2', import.meta.url)).toString('base64');
const TEXT = 'Hamburgefonstiv quick brown fox jumps over the lazy dog';
const html = `<!doctype html><html><head><style>
@font-face{font-family:T;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
body{margin:0;font-family:T} span{white-space:nowrap;display:inline-block}
</style></head><body><div id=host></div></body></html>`;

function probe({ specs, text }) {
  const host = document.getElementById('host');
  const mk = (style) => { const s = document.createElement('span'); s.textContent = text; s.setAttribute('style', style); host.appendChild(s); return s; };
  const out = {};
  for (const spec of specs) {
    const wAuto = mk(`font-size:${spec};font-optical-sizing:auto`).getBoundingClientRect().width;
    const wNone = mk(`font-size:${spec};font-optical-sizing:none`).getBoundingClientRect().width;
    let best = null;
    for (let o = 14; o <= 32; o += 0.25) {
      const w = mk(`font-size:${spec};font-variation-settings:'opsz' ${o}`).getBoundingClientRect().width;
      if (!best || Math.abs(w - wAuto) < Math.abs(best.w - wAuto)) best = { o, w };
    }
    out[spec] = { computed: getComputedStyle(host.firstChild).fontSize, opsz: best.o, fit: +(best.w - wAuto).toFixed(3), noneEqualsAuto: Math.abs(wNone - wAuto) < 0.01 };
    host.innerHTML = '';
  }
  return out;
}

const SPECS = ['8px', '16px', '18px', '22px', '25px', '30px', '1rem'];
const results = {};
for (const webprefs of [
  { minimum_font_size: 0, default_font_size: 16 },
  { minimum_font_size: 20, default_font_size: 16 },
  { minimum_font_size: 20, default_font_size: 24 },
  { minimum_font_size: 20, default_font_size: 18 },
  { minimum_font_size: 12, default_font_size: 16 },
]) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-spike10-'));
  mkdirSync(join(dir, 'Default'));
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ webkit: { webprefs } }));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true, viewport: { width: 1600, height: 800 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setContent(html);
  await page.evaluate(() => document.fonts.load('16px T'));
  const r = await page.evaluate(probe, { specs: SPECS, text: TEXT });
  const label = `min=${webprefs.minimum_font_size} default=${webprefs.default_font_size}`;
  results[label] = r;
  console.log(label.padEnd(22), Object.entries(r).map(([k, v]) => `${k}→${v.computed}/opsz ${v.opsz}${v.noneEqualsAuto ? '' : ''}${Math.abs(v.fit) > 0.05 ? `(fit ${v.fit})` : ''}`).join('  '));
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
}
writeFileSync(new URL('./results-minimum.json', import.meta.url), JSON.stringify(results, null, 2));
