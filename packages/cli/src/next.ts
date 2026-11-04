// `fontphobia/next` (§13): a Next.js adapter. `onBuildComplete` runs after the HTML exists, on
// Turbopack too. next.config.mjs: `adapterPath: fileURLToPath(import.meta.resolve('fontphobia/next'))`
// (Next require.resolve()s it: a path, not a file: URL), or the NEXT_ADAPTER_PATH environment
// variable. Options come from fontphobia.config's `check`.
import { postBuildCheck } from './integration.ts';

export default {
  name: 'fontphobia',
  async onBuildComplete(ctx: { projectDir: string }) {
    await postBuildCheck(ctx.projectDir, undefined);
  },
};
