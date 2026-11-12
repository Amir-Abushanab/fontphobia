/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules impossible to reason about or extract.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'Imports must resolve. scripts/build-bakery.mjs is excepted: it loads pngjs through packages/crawler with createRequire.',
      from: { pathNot: '^scripts/build-bakery\\.mjs$' },
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-dependencies',
      severity: 'error',
      comment:
        "Every runtime import must be declared in its own package.json. pnpm's store and the workspace root can make an undeclared import resolve here and fail for everyone who installs the published tarball.",
      from: { path: '^packages/' },
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
        dependencyTypesNot: ['npm', 'npm-dev', 'npm-peer', 'npm-optional'],
      },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment: 'Modules nothing imports are dead weight (entry points and hand-run scripts excepted).',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)src/index\\.ts$',
          '(^|/)src/cli\\.ts$',
          // The integrations: one entry per framework, named in packages/cli/package.json "exports".
          '^packages/cli/src/(vite|astro|nuxt|react-router|vitepress|docusaurus|eleventy|next|rsbuild|rspack|webpack|check-runtime)\\.ts$',
          '(^|/)scripts/[^/]+\\.mjs$',
        ],
      },
      to: {},
    },
    {
      name: 'core-has-no-browser',
      severity: 'error',
      comment:
        'packages/core is font I/O, subsetting, planning, build and check. It never drives a browser and never depends on the packages above it.',
      from: { path: '^packages/core/src' },
      to: { path: '^packages/(crawler|cli)/|(^|/)node_modules/playwright-core/' },
    },
    {
      name: 'crawler-does-not-reach-the-cli',
      severity: 'error',
      comment:
        'packages/crawler builds on core. The CLI and the integrations build on both, never the other way round.',
      from: { path: '^packages/crawler/src' },
      to: { path: '^packages/cli/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['/dist/', '(^|/)fixtures/', '(^|/)spikes/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.ts', '.mjs', '.js', '.d.ts'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
