// Does the OS text scale reach CSS px font sizes on desktop Chrome?
// Uses DevTools' "Emulate OS text scale" (CDP Emulation.setEmulatedOSTextScale)
// on pages with and without <meta name="text-scale" content="scale">, and with
// env(preferred-text-scale) in a calc().
import { chromium } from 'playwright-core';

const page_html = (meta) => `<!doctype html><html><head>${meta}<style>
#envProbe{font-size:calc(16px * env(preferred-text-scale, 1))}
</style></head><body><p id=rem style="font-size:1rem">x</p><p id=px style="font-size:16px">x</p><p id=envProbe>x</p></body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
console.log('chrome', browser.version());
for (const meta of ['', '<meta name="text-scale" content="scale">']) {
  for (const scale of [undefined, 1.5, 2]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    let err = '';
    if (scale) {
      try { await cdp.send('Emulation.setEmulatedOSTextScale', { scale }); } catch (e) { err = e.message.split('\n')[0]; }
    }
    await page.setContent(page_html(meta));
    const r = await page.evaluate(() => ['rem', 'px', 'envProbe'].map((id) => `${id}=${getComputedStyle(document.getElementById(id)).fontSize}`).join(' ') + ` root=${getComputedStyle(document.documentElement).fontSize}`);
    console.log(`${meta ? 'meta text-scale' : 'no meta'}`.padEnd(16), `os scale ${scale ?? 'none'}`.padEnd(14), r, err);
    await ctx.close();
  }
}
await browser.close();
