// `fontphobia/nuxt` (§13): a Nuxt module. Adds the Vite guards and the dev warning, and runs `check`
// once Nitro has written the prerendered HTML (`nitro:build:public-assets`, after `prerender:done`).
// nuxt.config: `modules: ['fontphobia/nuxt']`, or `[['fontphobia/nuxt', { mode: 'warn' }]]`.
import { devWarningScript, fontphobia as vitePlugin } from './vite.ts';
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

interface NuxtLike {
  options: { rootDir: string; dev: boolean; app: { head: { script?: unknown[] } } };
  hook(name: string, fn: (...args: never[]) => unknown): void;
}

export default function fontphobiaNuxt(o: FontphobiaCheckOptions = {}, nuxt: NuxtLike) {
  const root = nuxt.options.rootDir;
  nuxt.hook('vite:extendConfig', ((config: { plugins?: unknown[] }) => {
    (config.plugins ??= []).push(vitePlugin({ root, devWarnings: false }));
  }) as never);
  if (nuxt.options.dev) {
    const s = devWarningScript(root);
    if (s) (nuxt.options.app.head.script ??= []).push({ innerHTML: s, tagPosition: 'bodyClose' });
  }
  nuxt.hook('nitro:build:public-assets', (async (nitro: { options: { output: { publicDir: string } } }) => {
    await postBuildCheck(root, nitro.options.output.publicDir, o);
  }) as never);
}
(fontphobiaNuxt as unknown as { meta: unknown }).meta = { name: 'fontphobia', configKey: 'fontphobia' };
