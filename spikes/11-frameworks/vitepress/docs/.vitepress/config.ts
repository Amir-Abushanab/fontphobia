import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
const probe = {
  name: 'probe',
  closeBundle(this: any) {
    console.log('[probe] closeBundle', this.environment?.name ?? '-')
  }
}

export default defineConfig({
  head: [
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap' }]
  ],
  vite: { plugins: [probe] },
  // VitePress build hook: runs once after all pages are rendered to HTML.
  buildEnd(siteConfig) {
    console.log('[probe] buildEnd', siteConfig.outDir, JSON.stringify(siteConfig.pages))
  },
  title: "Fixture",
  description: "fontphobia fixture",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Examples', link: '/markdown-examples' }
    ],

    sidebar: [
      {
        text: 'Examples',
        items: [
          { text: 'Markdown Examples', link: '/markdown-examples' },
          { text: 'Runtime API Examples', link: '/api-examples' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/vuejs/vitepress' }
    ]
  }
})
