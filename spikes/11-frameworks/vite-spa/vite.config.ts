import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const probe: Plugin = {
  name: 'probe',
  closeBundle() {
    console.log('[probe] closeBundle', this.environment?.name ?? '-')
  },
}

// https://vite.dev/config/
export default defineConfig({
  // tanstackRouter must come before react()
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), probe],
})
