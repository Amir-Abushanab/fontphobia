import { existsSync } from 'node:fs';
import { defineConfig, type RsbuildPlugin } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/rspack';

// Rspack plugin probe: compiler.hooks.done
const probe = {
  apply(compiler: { hooks: { done: { tap: (n: string, f: () => void) => void } } }) {
    compiler.hooks.done.tap('probe', () => {
      console.log('[probe] compiler.hooks.done, dist/index.html exists:', existsSync('dist/index.html'));
    });
  },
};

// Rsbuild plugin probe: onAfterBuild
const rsbuildProbe: RsbuildPlugin = {
  name: 'rsbuild-probe',
  setup(api) {
    api.onAfterBuild(({ environments }) => {
      console.log('[probe] rsbuild onAfterBuild', Object.keys(environments), 'dist/index.html exists:', existsSync('dist/index.html'));
    });
  },
};

// Docs: https://rsbuild.rs/config/
export default defineConfig({
  plugins: [pluginReact(), rsbuildProbe],
  // FONT_INLINE=20000 pnpm build: raise the font data-URI threshold (Vite's assetsInlineLimit equivalent; default 4096 per type)
  output: process.env.FONT_INLINE ? { dataUriLimit: { font: Number(process.env.FONT_INLINE) } } : {},
  html: {
    title: 'Rsbuild SPA',
    tags: [
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
      {
        tag: 'link',
        attrs: { href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap', rel: 'stylesheet' },
      },
    ],
  },
  tools: {
    rspack: {
      plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), probe],
    },
  },
});
