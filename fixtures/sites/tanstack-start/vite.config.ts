import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

// Fixture for M2: crawled with no fontphobia config. /posts/3 is server-rendered only.
export default defineConfig({
  plugins: [
    tanstackStart({
      prerender: { enabled: true, crawlLinks: false },
      pages: [{ path: '/' }, { path: '/about' }, { path: '/posts/1' }, { path: '/posts/2' }],
    }),
    viteReact(),
  ],
})
