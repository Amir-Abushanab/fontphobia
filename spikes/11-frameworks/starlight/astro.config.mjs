// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

/** @type {import('vite').Plugin} */
const probe = {
  name: 'probe',
  closeBundle() {
    // @ts-ignore
    console.log('[probe] closeBundle', this.environment?.name ?? '-');
  },
};

// https://astro.build/config
export default defineConfig({
  vite: { plugins: [probe] },
  integrations: [
    starlight({
      title: 'My Docs',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/withastro/starlight' }],
      // Idiomatic Starlight font setup: fontsource via customCss + --sl-font.
      customCss: ['@fontsource-variable/inter', './src/styles/fonts.css'],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap',
          },
        },
      ],
      sidebar: [
        {
          label: 'Guides',
          items: [
            // Each item here is one entry in the navigation menu.
            { label: 'Example Guide', slug: 'guides/example' },
          ],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
    {
      name: 'probe-integration',
      hooks: {
        'astro:build:done': ({ dir, pages }) =>
          console.log('[probe] astro:build:done', dir.pathname, JSON.stringify(pages.map((p) => p.pathname))),
      },
    },
  ],
});
