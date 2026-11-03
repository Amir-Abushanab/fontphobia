// Framework profiles (§7.1.1). Data: how to detect the framework, where the build output is,
// how to start its production server, where its route list lives.

export type RouteSource =
  | 'html' | 'sitemap' | 'next-manifest' | 'nuxt-meta' | 'angular-prerendered' | 'tanstack-route-tree'
  | 'foldkit-build' | 'gatsby-page-data' | 'astro-ssr-entry' | 'octane-config' | 'react-router';

export interface ServerSpec {
  /** Shell command, run in the project root (or `cwd`). */
  cmd: string;
  /** Server mode applies only when this file exists (relative to the project root). */
  when: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface Profile {
  id: string;
  name: string;
  tier: 1 | 2;
  /** All must be present: dependency names (package.json) or files (relative, `|` = any of). */
  deps?: string[];
  files?: string[];
  /** Higher wins when several profiles match (Starlight over Astro, Analog over Angular). */
  priority: number;
  /** Static output directories, first match with HTML wins. `*` matches one directory level. */
  output: string[];
  server?: ServerSpec[];
  /** Prefer the static output over the server when both exist (prerendered sites). */
  preferStatic?: boolean;
  /** The preview server answers 200 with index.html for every path. */
  spaFallback?: boolean;
  routes: RouteSource[];
  /** Where head tags live, for google-fonts detection (§6.5). Informational in M2. */
  head: string[];
  /** The hook that runs after HTML exists (§13). */
  hook: string;
  build?: string;
}

export const PROFILES: Profile[] = [
  { id: 'next', name: 'Next.js', tier: 1, deps: ['next'], priority: 10, output: ['out'], preferStatic: true,
    server: [{ cmd: 'npx --no-install next start -p $PORT -H 127.0.0.1', when: '.next/BUILD_ID' }],
    routes: ['next-manifest', 'html', 'sitemap'], head: ['app/layout.tsx', 'pages/_document.tsx'], hook: 'adapter onBuildComplete (NEXT_ADAPTER_PATH)' },
  { id: 'starlight', name: 'Starlight', tier: 1, deps: ['@astrojs/starlight'], priority: 30, output: ['dist/client', 'dist'],
    server: [{ cmd: 'node dist/server/entry.mjs', when: 'dist/server/entry.mjs' }],
    routes: ['html', 'astro-ssr-entry', 'sitemap'], head: ['astro.config.* starlight({ head })'], hook: 'astro:build:done' },
  { id: 'astro', name: 'Astro', tier: 1, deps: ['astro'], priority: 20, output: ['dist/client', 'dist'],
    server: [{ cmd: 'node dist/server/entry.mjs', when: 'dist/server/entry.mjs' }],
    routes: ['html', 'astro-ssr-entry', 'sitemap'], head: ['src/layouts/*.astro'], hook: 'astro:build:done' },
  { id: 'nuxt', name: 'Nuxt', tier: 1, deps: ['nuxt'], priority: 20, output: ['.output/public', 'dist'],
    server: [{ cmd: 'node .output/server/index.mjs', when: '.output/server/index.mjs' }],
    routes: ['nuxt-meta', 'html', 'sitemap'], head: ['nuxt.config.* app.head', 'useHead()'], hook: 'Nitro prerender:done' },
  { id: 'sveltekit', name: 'SvelteKit', tier: 1, deps: ['@sveltejs/kit'], priority: 20, output: ['build', '.svelte-kit/output/prerendered/pages'],
    server: [{ cmd: 'node build', when: 'build/index.js' }],
    routes: ['html', 'sitemap'], head: ['src/app.html', '<svelte:head>'], hook: "wrap the adapter's adapt(), or postbuild" },
  { id: 'solidstart', name: 'SolidStart', tier: 1, deps: ['@solidjs/start'], priority: 20, output: ['.output/public'],
    server: [{ cmd: 'node .output/server/index.mjs', when: '.output/server/index.mjs' }],
    routes: ['html', 'sitemap'], head: ['src/entry-server.tsx', '@solidjs/meta'], hook: 'Nitro prerender:done' },
  { id: 'tanstack-start', name: 'TanStack Start', tier: 1, deps: ['@tanstack/react-start|@tanstack/solid-start'], priority: 20, output: ['dist/client', '.output/public'], preferStatic: true,
    server: [{ cmd: 'node .output/server/index.mjs', when: '.output/server/index.mjs' }, { cmd: 'npx --no-install vite preview --port $PORT --strictPort --host 127.0.0.1', when: 'dist/server/server.js' }],
    routes: ['tanstack-route-tree', 'html', 'sitemap'], head: ['src/routes/__root.tsx head()'], hook: 'none, so postbuild' },
  { id: 'react-router', name: 'React Router', tier: 1, deps: ['@react-router/dev|@remix-run/dev'], priority: 20, output: ['build/client'],
    server: [{ cmd: 'npx --no-install react-router-serve build/server/index.js', when: 'build/server/index.js' }],
    routes: ['react-router', 'html', 'sitemap'], head: ['app/root.tsx links()'], hook: 'config buildEnd' },
  { id: 'qwik', name: 'Qwik City', tier: 2, deps: ['@builder.io/qwik-city|@qwik.dev/router'], priority: 20, output: ['dist'],
    routes: ['sitemap', 'html'], head: ['src/components/router-head/router-head.tsx'], hook: 'none, so postbuild' },
  { id: 'analog', name: 'Analog', tier: 1, deps: ['@analogjs/platform'], priority: 30, output: ['dist/analog/public'],
    server: [{ cmd: 'node dist/analog/server/index.mjs', when: 'dist/analog/server/index.mjs' }],
    routes: ['html', 'sitemap'], head: ['index.html', 'route meta'], hook: 'Nitro prerender:done' },
  { id: 'angular', name: 'Angular', tier: 1, files: ['angular.json'], priority: 20, output: ['dist/*/browser'],
    server: [{ cmd: 'node dist/*/server/server.mjs', when: 'dist/*/server/server.mjs', env: { NG_ALLOWED_HOSTS: 'localhost,127.0.0.1' } }],
    routes: ['angular-prerendered', 'html', 'sitemap'], head: ['src/index.html'], hook: 'no user plugins, so postbuild' },
  { id: 'gatsby', name: 'Gatsby', tier: 2, deps: ['gatsby'], priority: 20, output: ['public'],
    routes: ['gatsby-page-data', 'html', 'sitemap'], head: ['gatsby-ssr onRenderBody'], hook: 'onPostBuild' },
  { id: 'docusaurus', name: 'Docusaurus', tier: 1, deps: ['@docusaurus/core'], priority: 20, output: ['build'],
    routes: ['html', 'sitemap'], head: ['docusaurus.config.* stylesheets, headTags'], hook: 'plugin postBuild' },
  { id: 'vitepress', name: 'VitePress', tier: 1, deps: ['vitepress'], priority: 20, output: ['.vitepress/dist', 'docs/.vitepress/dist', '*/.vitepress/dist'],
    routes: ['html', 'sitemap'], head: ['.vitepress/config.* head'], hook: 'config buildEnd' },
  { id: 'foldkit', name: 'Foldkit', tier: 2, deps: ['foldkit', '@foldkit/vite-plugin'], priority: 15, output: ['dist/client', 'dist'],
    routes: ['foldkit-build', 'html'], head: ['server entry renderDocument(…, { head })'], hook: "buildApp hook with order: 'post'" },
  { id: 'octane', name: 'Octane', tier: 2, deps: ['octane', '@octanejs/vite-plugin'], priority: 15, output: [],
    server: [{ cmd: 'node dist/server/entry.js', when: 'dist/server/entry.js' }],
    routes: ['octane-config', 'sitemap'], head: ['index.html <!--ssr-head-->'], hook: 'none sees HTML, so postbuild' },
  { id: 'rsbuild', name: 'Rsbuild', tier: 1, deps: ['@rsbuild/core'], priority: 12, output: ['dist'], spaFallback: true,
    routes: ['html', 'sitemap'], head: ['rsbuild.config.* html.tags'], hook: 'api.onAfterBuild' },
  { id: 'rspack', name: 'Rspack', tier: 1, deps: ['@rspack/cli|@rspack/core'], priority: 11, output: ['dist'],
    routes: ['html', 'sitemap'], head: ['HTML template'], hook: 'compiler.hooks.done' },
  { id: 'eleventy', name: 'Eleventy', tier: 1, deps: ['@11ty/eleventy'], priority: 20, output: ['_site'],
    routes: ['html', 'sitemap'], head: ['layouts'], hook: 'eleventy.after' },
  { id: 'jekyll', name: 'Jekyll', tier: 2, files: ['_config.yml|_config.yaml', 'Gemfile'], priority: 5, output: ['_site'], build: 'bundle exec jekyll build',
    routes: ['html', 'sitemap'], head: ['_includes/head.html'], hook: 'Ruby post_write hook' },
  { id: 'hugo', name: 'Hugo', tier: 1, files: ['hugo.toml|hugo.yaml|hugo.yml|hugo.json|config.toml'], priority: 5, output: ['public'], build: 'hugo',
    routes: ['sitemap', 'html'], head: ['layouts/_partials/head.html'], hook: 'none, so a wrapper script' },
  { id: 'vite', name: 'Vite', tier: 1, deps: ['vite'], priority: 1, output: ['dist'], spaFallback: true,
    routes: ['html', 'tanstack-route-tree', 'sitemap'], head: ['index.html'], hook: 'closeBundle' },
];

export const GENERIC: Profile = { id: 'static', name: 'static site', tier: 1, priority: 0, output: ['dist', 'build', 'out', 'public', '_site', '.'], routes: ['html', 'sitemap'], head: [], hook: 'postbuild' };
