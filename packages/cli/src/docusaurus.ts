// `fontphobia/docusaurus` (§13): a Docusaurus plugin. `check` in `postBuild`; keeps fontphobia's
// files out of webpack/Rspack asset inlining. docusaurus.config: `plugins: ['fontphobia/docusaurus']`.
import { OUTPUT_NAME } from './vite.ts';
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

export default function fontphobiaDocusaurus(context: { siteDir: string }, o: FontphobiaCheckOptions = {}) {
  return {
    name: 'fontphobia',
    configureWebpack() { return { module: { rules: [{ test: OUTPUT_NAME, type: 'asset/resource' }] } }; },
    async postBuild({ outDir }: { outDir: string }) { await postBuildCheck(context.siteDir, outDir, o); },
  };
}
