import fs from 'node:fs';
import path from 'node:path';

/** @type {import('next').NextAdapter} */
export default {
  name: 'probe',
  onBuildComplete(ctx) {
    const out = path.join(ctx.projectDir, 'out');
    const outHtml = fs.existsSync(out)
      ? fs.readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith('.html'))
      : null;
    const kinds = {};
    for (const [k, v] of Object.entries(ctx.outputs)) kinds[k] = Array.isArray(v) ? v.length : typeof v;
    console.log(
      '[probe] adapter onBuildComplete',
      JSON.stringify({ output: ctx.config.output ?? null, outputs: kinds, outHtml }),
    );
    const pre = (ctx.outputs.prerenders ?? []).map((p) => p.pathname);
    console.log('[probe] adapter prerender pathnames', JSON.stringify(pre));
    const st = (ctx.outputs.staticFiles ?? []).map((p) => p.pathname).filter((p) => !p.startsWith('/_next'));
    console.log('[probe] adapter staticFiles', JSON.stringify(st));
  },
};
