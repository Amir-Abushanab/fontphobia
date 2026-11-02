// https://nuxt.com/docs/api/configuration/nuxt-config
// NUXT_FONTS=1 enables @nuxt/fonts; NUXT_FONTS=no-fraunces also sets Fraunces to provider 'none'.
const fontsMode = process.env.NUXT_FONTS

const probe = {
  name: 'probe',
  closeBundle(this: any) {
    console.log('[probe] closeBundle', this.environment?.name ?? '-')
  }
}

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: fontsMode ? ['@nuxt/fonts'] : [],
  ...(fontsMode
    ? {
        fonts: {
          families: fontsMode === 'no-fraunces' ? [{ name: 'Fraunces', provider: 'none' }] : []
        }
      }
    : {}),
  css: ['@fontsource-variable/inter'],
  app: {
    head: {
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap' }
      ]
    }
  },
  nitro: {
    prerender: { routes: ['/', '/about', '/posts/1', '/posts/2'] },
    hooks: {
      'prerender:done': (ctx: any) => console.log('[probe] nitro prerender:done', JSON.stringify(ctx.prerenderedRoutes?.map((r: any) => r.route) ?? ctx)),
      compiled: () => console.log('[probe] nitro compiled'),
      close: () => console.log('[probe] nitro close')
    }
  },
  vite: { plugins: [probe] },
  hooks: {
    'build:done': () => console.log('[probe] nuxt build:done'),
    'nitro:build:public-assets': () => console.log('[probe] nuxt nitro:build:public-assets'),
    close: () => console.log('[probe] nuxt close')
  }
})
