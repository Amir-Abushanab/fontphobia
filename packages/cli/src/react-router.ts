// `fontphobia/react-router` (§13): `check` in React Router's `buildEnd`, once the client build and
// prerendered HTML exist. react-router.config.ts: `export default { buildEnd: fontphobia() }`.
// Add `fontphobia/vite` to vite.config for the build-time guards.
import { join } from 'node:path';
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

export default function fontphobia(o: FontphobiaCheckOptions & { root?: string } = {}) {
  return async ({
    reactRouterConfig,
    viteConfig,
  }: {
    reactRouterConfig: { buildDirectory: string };
    viteConfig: { root: string };
  }) => {
    await postBuildCheck(o.root ?? viteConfig.root, join(reactRouterConfig.buildDirectory, 'client'), o);
  };
}
