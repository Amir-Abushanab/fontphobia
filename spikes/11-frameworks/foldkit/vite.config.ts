import { existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const probe: Plugin = {
  name: 'probe',
  closeBundle() {
    console.log('[probe] closeBundle', this.environment?.name ?? '-')
  },
  // Vite plugin-level buildApp, after Foldkit's own `order: 'post'` finalize
  buildApp: {
    order: 'post',
    handler() {
      console.log(
        '[probe] buildApp post, posts/2 html exists:',
        existsSync('dist/client/posts/2/index.html'),
      )
    },
  },
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    foldkit({
      ssr: {
        serverEntry: '/src/entry.server.ts',
        clientEntry: '/src/entry.ts',
        build: { prerender: true },
      },
    }),
    probe,
  ],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})
