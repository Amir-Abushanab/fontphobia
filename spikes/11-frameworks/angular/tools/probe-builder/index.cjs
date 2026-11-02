// Local custom builder: the application builder has no user-plugin option in angular.json,
// but buildApplication(options, context, { codePlugins, indexHtmlTransformer }) accepts them
// (documented as experimental / unsupported).
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'node_modules/@angular/build/package.json'));
const { createBuilder } = req('@angular-devkit/architect');
const { buildApplication } = req('@angular/build');

const probe = {
  name: 'probe',
  setup(build) {
    const platform = build.initialOptions.platform;
    build.onEnd((result) => console.log('[probe] esbuild onEnd', platform, 'errors=' + result.errors.length));
  },
};

async function* run(options, context) {
  for await (const result of buildApplication(options, context, {
    codePlugins: [probe],
    indexHtmlTransformer: async (html) => {
      console.log('[probe] indexHtmlTransformer');
      return html;
    },
  })) {
    // Each yielded result = a finished build (output written, prerender done).
    const fs = require('node:fs');
    const dir = path.join(root, 'dist/angular/browser');
    const html = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.html')) : null;
    console.log('[probe] builder result', JSON.stringify({ success: result.success, html }));
    yield result;
  }
}

module.exports = createBuilder(run);
