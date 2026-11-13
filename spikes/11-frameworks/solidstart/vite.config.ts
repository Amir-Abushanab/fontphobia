import { defineConfig, type Plugin } from 'vite';
import { nitro } from 'nitro/vite';

import { solidStart } from '@solidjs/start/config';

const probe: Plugin = {
  name: 'probe',
  closeBundle() {
    // @ts-ignore
    console.log('[probe] closeBundle', this.environment?.name ?? '-');
  },
};

// SOLID_STATIC=1 -> nitro preset "static" (no server).
const isStatic = process.env.SOLID_STATIC === '1';

export default defineConfig({
  plugins: [
    solidStart(),
    nitro({
      ...(isStatic ? { preset: 'static' } : {}),
      prerender: { routes: ['/', '/about', '/posts/1', '/posts/2'], crawlLinks: false },
      hooks: {
        'prerender:done': (ctx: any) =>
          console.log('[probe] nitro prerender:done', JSON.stringify(ctx.prerenderedRoutes?.map((r: any) => r.route))),
        compiled: () => console.log('[probe] nitro compiled'),
        close: () => console.log('[probe] nitro close'),
      },
    } as any),
    probe,
  ],
});
