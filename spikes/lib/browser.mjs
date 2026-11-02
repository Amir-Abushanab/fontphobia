import { chromium } from 'playwright-core';
export async function launch(opts = {}) {
  return chromium.launch({ ...(process.env.BUNDLED ? {} : { channel: 'chrome' }), headless: true, ...opts });
}
export const dataUrl = (bytes, mime = 'font/ttf') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
