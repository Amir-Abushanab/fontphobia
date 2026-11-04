// `fontphobia/next` (§13): a Next.js adapter. `onBuildComplete` runs after the HTML exists, on
// Turbopack too. next.config: `adapterPath: import.meta.resolve('fontphobia/next')` (or the
// NEXT_ADAPTER_PATH environment variable). Options come from fontphobia.config's `check`.
import { postBuildCheck } from './integration.ts';

export default {
  name: 'fontphobia',
  async onBuildComplete(ctx: { projectDir: string }) {
    await postBuildCheck(ctx.projectDir, undefined);
  },
};
