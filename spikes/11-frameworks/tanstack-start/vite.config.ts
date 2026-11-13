import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';

import { tanstackStart } from '@tanstack/react-start/plugin/vite';

import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const probe = {
  name: 'probe',
  closeBundle(this: any) {
    console.log('[probe] closeBundle', this.environment?.name ?? '-');
  },
};

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: false },
      pages: [{ path: '/' }, { path: '/about' }, { path: '/posts/1' }, { path: '/posts/2' }],
    }),
    viteReact(),
    probe,
  ],
});

export default config;
