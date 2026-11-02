import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtensions: () => ({ js: '.mjs' }),
  // Bundle everything (PLAN §4): dlx has no lockfile, so nothing is resolved at install time.
  noExternal: [/.*/],
  dts: false,
  // wawoff2's Emscripten CJS glue reads __dirname; inject ESM shims for it.
  shims: true,
  // harfbuzz.js loads harfbuzz.wasm next to the bundle; the subsetter WASM is found the same way.
  copy: [
    { from: '../../node_modules/.pnpm/harfbuzzjs@1.6.4/node_modules/harfbuzzjs/dist/harfbuzz.wasm', to: 'dist' },
    { from: '../../node_modules/.pnpm/harfbuzzjs@1.6.4/node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm', to: 'dist' },
  ],
});
