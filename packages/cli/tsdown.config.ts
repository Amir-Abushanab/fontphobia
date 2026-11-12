import { defineConfig } from 'tsdown';
import { thirdPartyNotices } from './scripts/third-party-notices.mjs';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    vite: 'src/vite.ts',
    astro: 'src/astro.ts',
    nuxt: 'src/nuxt.ts',
    'react-router': 'src/react-router.ts',
    vitepress: 'src/vitepress.ts',
    docusaurus: 'src/docusaurus.ts',
    eleventy: 'src/eleventy.ts',
    next: 'src/next.ts',
    rsbuild: 'src/rsbuild.ts',
    rspack: 'src/rspack.ts',
    webpack: 'src/webpack.ts',
    'check-runtime': 'src/check-runtime.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtensions: () => ({ js: '.mjs' }),
  // Bundle everything (PLAN §4): dlx has no lockfile, so nothing is resolved at install time.
  // The one exception is playwright-core, pinned to an exact version in package.json.
  noExternal: [/^(?!playwright-core(\/|$))/],
  external: ['playwright-core'],
  // Declarations for the entries in package.json exports, so the typed Config reaches users.
  dts: true,
  plugins: [thirdPartyNotices()],
  // wawoff2's Emscripten CJS glue reads __dirname; inject ESM shims for it.
  shims: true,
  // harfbuzz.js loads harfbuzz.wasm next to the bundle; the subsetter WASM is found the same way.
  copy: [
    { from: '../../node_modules/.pnpm/harfbuzzjs@1.6.4/node_modules/harfbuzzjs/dist/harfbuzz.wasm', to: 'dist' },
    { from: '../../node_modules/.pnpm/harfbuzzjs@1.6.4/node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm', to: 'dist' },
  ],
});
