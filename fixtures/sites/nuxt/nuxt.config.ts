// Fixture for M7 (`nuxt-fonts`, §6.8): @nuxt/fonts resolves Merriweather from Google for the CSS that
// names it. Static output in .output/public (`nuxt generate`).
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@nuxt/fonts'],
  fonts: {
    families: [{ name: 'Merriweather', provider: 'google', weights: [300, 400, 700] }],
  },
  nitro: { prerender: { routes: ['/', '/about', '/posts/1', '/posts/2'] } },
})
