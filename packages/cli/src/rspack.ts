// `fontphobia/rspack` and `fontphobia/webpack` (§13): a compiler plugin. Marks fontphobia's files
// `asset/resource` (asset modules inline anything under 8 KiB by default), and runs `check` in
// `compiler.hooks.done`, after HtmlRspackPlugin / HtmlWebpackPlugin wrote the HTML.
// Config: `plugins: [new FontphobiaPlugin()]`.
import { OUTPUT_NAME } from './vite.ts';
import { postBuildCheck, type FontphobiaCheckOptions } from './integration.ts';

interface CompilerLike {
  context: string;
  options: { mode?: string; output: { path?: string }; module: { rules: unknown[] } };
  hooks: { done: { tapPromise(name: string, fn: (stats: { hasErrors(): boolean }) => Promise<void>): void } };
}

export class FontphobiaPlugin {
  private o: FontphobiaCheckOptions & { root?: string };
  constructor(o: FontphobiaCheckOptions & { root?: string } = {}) {
    this.o = o;
  }
  apply(compiler: CompilerLike) {
    compiler.options.module.rules.push({ test: OUTPUT_NAME, type: 'asset/resource' });
    if (compiler.options.mode === 'development') return;
    compiler.hooks.done.tapPromise('fontphobia', async (stats) => {
      if (stats.hasErrors()) return;
      await postBuildCheck(this.o.root ?? compiler.context, compiler.options.output.path, this.o);
    });
  }
}
export default FontphobiaPlugin;
