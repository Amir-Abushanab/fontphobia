// With a minimum font size set, Chrome's auto opsz for text at a given *used*
// size depends on which *specified* size was rendered at that used size first.
// Each order runs in a fresh profile with minimum_font_size 20, default 16.
// Widths are mapped back to the explicit opsz they match.
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const font = readFileSync(new URL('./font/inter-opsz-wght-latin.woff2', import.meta.url)).toString('base64');
const TEXT = 'Hamburgefonstiv quick brown fox jumps over the lazy dog';
const html = `<!doctype html><html><head><style>@font-face{font-family:T;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
body{margin:0;font-family:T} span{white-space:nowrap;display:inline-block}</style></head><body><div id=host></div></body></html>`;
const ORDERS = [['20px', '16px', '8px'], ['8px', '20px', '16px'], ['16px', '8px', '20px']];

for (const order of ORDERS) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-spike10-'));
  mkdirSync(join(dir, 'Default'));
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ webkit: { webprefs: { minimum_font_size: 20, default_font_size: 16 } } }));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setContent(html);
  await page.evaluate(() => document.fonts.load('16px T'));
  const r = await page.evaluate(([text, order]) => {
    const host = document.getElementById('host');
    const w = (st) => { const s = document.createElement('span'); s.textContent = text; s.setAttribute('style', st); host.appendChild(s); return s.getBoundingClientRect().width; };
    const out = [];
    for (const sz of order) {
      const auto = w(`font-size:${sz};font-optical-sizing:auto`);
      let best = null;
      for (let o = 14; o <= 32; o += 0.5) { const x = w(`font-size:20px;font-variation-settings:'opsz' ${o}`); if (!best || Math.abs(x - auto) < Math.abs(best.x - auto)) best = { o, x }; }
      out.push(`${sz}→opsz ${best.o}`);
    }
    return out.join('  ');
  }, [TEXT, order]);
  console.log(`order ${order.join(',')}:`.padEnd(26), r);
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
}
