// `fontphobia/eleventy` (§13): an Eleventy plugin. `check` on `eleventy.after` in build mode.
// eleventy.config: `eleventyConfig.addPlugin(fontphobia)`, or `addPlugin(fontphobia, { mode: 'warn' })`.
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

export default function fontphobiaEleventy(
  eleventyConfig: { on(event: string, fn: (e: { dir: { output: string }; runMode?: string }) => unknown): void },
  o: FontphobiaCheckOptions & { root?: string } = {},
) {
  eleventyConfig.on('eleventy.after', async ({ dir, runMode }) => {
    if (runMode && runMode !== 'build') return;
    await postBuildCheck(o.root ?? process.cwd(), dir.output, o);
  });
}
