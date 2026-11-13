/// <reference types="vitest" />

import { defineConfig } from 'vite';
import analog from '@analogjs/platform';

// https://vitejs.dev/config/
const probe = {
  name: 'probe',
  closeBundle(this: any) {
    console.log('[probe] closeBundle', this.environment?.name ?? '-');
  },
};

export default defineConfig(({ mode }) => ({
  build: {
    target: ['es2020'],
  },
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    analog({
      prerender: { routes: ['/', '/about', '/posts/1', '/posts/2'] },
      nitro: {
        hooks: {
          'prerender:done': (ctx: any) =>
            console.log(
              '[probe] nitro prerender:done',
              JSON.stringify(ctx.prerenderedRoutes?.map((r: any) => r.route)),
            ),
          close: () => console.log('[probe] nitro close'),
        },
      },
    }),
    probe,
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['**/*.spec.ts'],
    reporters: ['default'],
  },
}));
