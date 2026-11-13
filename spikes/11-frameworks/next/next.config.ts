import type { NextConfig } from 'next';
import path from 'node:path';

// FONTPHOBIA_EXPORT=1 -> `output: 'export'` (static, writes out/); otherwise `next start`.
const isExport = process.env.FONTPHOBIA_EXPORT === '1';

const nextConfig: NextConfig = {
  // create-next-app 16.4 starter enables these; both must be off for `output: 'export'`
  // ("Invariant: PPR cannot be enabled in export mode").
  cacheComponents: !isExport,
  partialPrefetching: !isExport,
  ...(isExport ? { output: 'export' as const, images: { unoptimized: true } } : {}),
  // Bundler-agnostic hook (works with Turbopack): runs after the build.
  // Must be absolute: a relative path is resolved from next/dist/server/config.js.
  adapterPath: path.resolve(process.cwd(), 'probe-adapter.mjs'),
  compiler: {
    // Runs after compile, BEFORE prerendering (so no HTML yet).
    runAfterProductionCompile: async ({ distDir }) => {
      console.log('[probe] runAfterProductionCompile', distDir);
    },
  },
  // A `webpack` key with no `turbopack` key makes a default (Turbopack) build exit 1.
  turbopack: {},
  // Only used by `next build --webpack`; Turbopack ignores this.
  webpack(config, { isServer, nextRuntime }) {
    config.plugins.push({
      apply(compiler: any) {
        compiler.hooks.done.tap('probe', () => {
          console.log('[probe] webpack done', compiler.name ?? '-', isServer ? `server:${nextRuntime}` : 'client');
        });
      },
    });
    return config;
  },
};

export default nextConfig;
