// Spike 10: what the browser font-size settings do to computed CSS px sizes and
// to the opsz Chrome applies with `font-optical-sizing: auto`.
//
// A. Default font size via CDP Page.setFontSizes (what the audit sweep uses),
//    at Chrome's presets and slider extremes, plus values outside the UI range.
// B. The same default size set through the real pref (Default/Preferences in a
//    fresh profile), to check CDP matches the setting.
// C. Minimum font size (webkit.webprefs.minimum_font_size), which CDP can't set:
//    does it change getComputedStyle().fontSize, layout, and opsz?
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const font = readFileSync(new URL('./font/inter-opsz-wght-latin.woff2', import.meta.url)).toString('base64');
const TEXT = 'Hamburgefonstiv quick brown fox jumps over the lazy dog';
const html = `<!doctype html><html><head><style>
@font-face{font-family:T;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
body{margin:0;font-family:T}
span{white-space:nowrap;display:inline-block}
</style></head><body><div id=host></div></body></html>`;

// In page: computed size of several specified sizes, and the opsz value whose
// explicit rendering matches the width of the auto-opsz rendering.
function probe({ specs, text }) {
  const host = document.getElementById('host');
  const mk = (style) => {
    const s = document.createElement('span');
    s.textContent = text;
    s.setAttribute('style', style);
    host.appendChild(s);
    host.appendChild(document.createElement('br'));
    return s;
  };
  const out = {};
  for (const spec of specs) {
    const auto = mk(`font-size:${spec};font-optical-sizing:auto`);
    const wAuto = auto.getBoundingClientRect().width;
    let best = null;
    for (let o = 14; o <= 32; o += 0.5) {
      const w = mk(`font-size:${spec};font-variation-settings:'opsz' ${o}`).getBoundingClientRect().width;
      if (!best || Math.abs(w - wAuto) < Math.abs(best.w - wAuto)) best = { o, w };
    }
    // Rendered size: height of a 1-line box with line-height:1 equals used font size.
    const lh = mk(`font-size:${spec};line-height:1`);
    out[spec] = {
      computed: getComputedStyle(auto).fontSize,
      usedLineBox: +lh.getBoundingClientRect().height.toFixed(2),
      opsz: best.o,
      fit: +(best.w - wAuto).toFixed(3),
    };
    host.innerHTML = '';
  }
  return out;
}

const SPECS = ['1rem', '0.75rem', 'medium', 'small', '16px', '8px', '12px'];
const fmt = (r) => Object.entries(r).map(([k, v]) => `${k}=${v.computed}/opsz ${v.opsz}${Math.abs(v.fit) > 0.01 ? `(fit ${v.fit})` : ''}`).join('  ');
const results = { chrome: null, cdp: {}, pref: {}, minimum: {} };

// A. CDP
{
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  results.chrome = browser.version();
  console.log('chrome', results.chrome);
  for (const standard of [9, 12, 16, 20, 24, 72, 6, 100]) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 800 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Page.setFontSizes', { fontSizes: { standard } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.load('16px T'));
    const r = await page.evaluate(probe, { specs: SPECS, text: TEXT });
    results.cdp[standard] = r;
    console.log(`A cdp standard=${standard}`.padEnd(30), fmt(r));
    await ctx.close();
  }
  await browser.close();
}

// B and C: real prefs in a fresh profile.
const withPrefs = async (label, webprefs, bucket) => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-spike10-'));
  mkdirSync(join(dir, 'Default'));
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ webkit: { webprefs: webprefs } }));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true, viewport: { width: 1600, height: 800 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setContent(html);
  await page.evaluate(() => document.fonts.load('16px T'));
  const r = await page.evaluate(probe, { specs: SPECS, text: TEXT });
  bucket[label] = { webprefs, r };
  console.log(label.padEnd(30), fmt(r));
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
};
await withPrefs('B pref default=24', { default_font_size: 24 }, results.pref);
await withPrefs('B pref default=9', { default_font_size: 9 }, results.pref);
await withPrefs('C min=0 (default)', { minimum_font_size: 0 }, results.minimum);
await withPrefs('C min=12', { minimum_font_size: 12 }, results.minimum);
await withPrefs('C min=20', { minimum_font_size: 20 }, results.minimum);
await withPrefs('C min=24 default=9', { minimum_font_size: 24, default_font_size: 9 }, results.minimum);

writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
