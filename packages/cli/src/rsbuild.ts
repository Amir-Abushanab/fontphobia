// `fontphobia/rsbuild` (§13): an Rsbuild plugin. Rsbuild's `output.dataUriLimit` is per asset type,
// not per file, so fontphobia's files are marked `asset/resource` instead of changing the limit; `check`
// runs in `onAfterBuild`. rsbuild.config: `plugins: [fontphobia()]`.
import { OUTPUT_NAME } from './vite.ts';
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

interface RsbuildApi {
  context: { rootPath: string; distPath: string };
  modifyRspackConfig(fn: (config: { module?: { rules?: unknown[] } }) => void): void;
  onAfterBuild(fn: (p: { isFirstCompile?: boolean }) => unknown): void;
}

export default function fontphobia(o: FontphobiaCheckOptions = {}) {
  return {
    name: 'fontphobia',
    setup(api: RsbuildApi) {
      api.modifyRspackConfig((config) => {
        ((config.module ??= {}).rules ??= []).push({ test: OUTPUT_NAME, type: 'asset/resource' });
      });
      api.onAfterBuild(async () => {
        await postBuildCheck(api.context.rootPath, api.context.distPath, o);
      });
    },
  };
}
