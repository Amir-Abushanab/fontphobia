// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import node from '@astrojs/node';

// ASTRO_FONTS=1 turns on the (stable, top-level) Fonts API for two Google families.
// ASTRO_FONTS=roboto-only drops Lora from it, to show how to remove one family.
const fontsMode = process.env.ASTRO_FONTS;

/** @type {import('vite').Plugin} */
const probe = {
  name: 'probe',
  closeBundle() {
    // @ts-ignore
    console.log('[probe] closeBundle', this.environment?.name ?? '-');
  },
};

// https://astro.build/config
// ASTRO_SSR=1 -> on-demand rendering via @astrojs/node standalone (posts stay prerendered).
const ssr = process.env.ASTRO_SSR === '1';

export default defineConfig({
  ...(ssr ? { output: 'server', adapter: node({ mode: 'standalone' }) } : {}),
  vite: { plugins: [probe] },
  integrations: [
    {
      name: 'probe-integration',
      hooks: {
        'astro:build:done': ({ dir, pages }) =>
          console.log('[probe] astro:build:done', dir.pathname, JSON.stringify(pages.map((p) => p.pathname))),
      },
    },
  ],
  fonts: fontsMode
    ? [
        { provider: fontProviders.google(), name: 'Roboto', cssVariable: '--font-roboto', weights: ['400 700'] },
        ...(fontsMode === 'roboto-only'
          ? []
          : [{ provider: fontProviders.google(), name: 'Lora', cssVariable: '--font-lora', fallbacks: ['serif'] }]),
      ]
    : undefined,
});
