// `fontphobia/vitepress` (§13): `check` in VitePress's `buildEnd`. .vitepress/config:
// `buildEnd: fontphobia()`, and `vite: { plugins: [vitePlugin()] }` from `fontphobia/vite` for the guards.
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

export default function fontphobia(o: FontphobiaCheckOptions & { root?: string } = {}) {
  // The project root (where fontphobia ran), not VitePress's docs root.
  return async (siteConfig: { outDir: string }) => { await postBuildCheck(o.root ?? process.cwd(), siteConfig.outDir, o); };
}
