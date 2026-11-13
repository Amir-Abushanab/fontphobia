// SSG for the Octane fullstack template: render every RenderRoute through the
// built production handler (same HTML the server streams) into dist/static.
// Usage: pnpm build && node scripts/ssg.mjs
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { handler } from '../dist/server/entry.js';
import octaneConfig from '../octane.config.ts';

const params = { '/posts/:id': [{ id: '1' }, { id: '2' }] };
const out = 'dist/static';
await cp('dist/client', out, { recursive: true });

const routes = octaneConfig.router.routes;
console.log('[ssg] routes', JSON.stringify(routes.map((r) => ({ type: r.type, path: r.path }))));
for (const route of routes.filter((r) => r.type === 'render')) {
  const paths = route.path.includes(':')
    ? (params[route.path] ?? []).map((p) => route.path.replace(/:(\w+)/g, (_, k) => p[k]))
    : [route.path];
  for (const path of paths) {
    const res = await handler(new Request('http://localhost' + path));
    const file = join(out, path, 'index.html');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await res.text());
    console.log('[ssg]', res.status, path, '->', file);
  }
}
process.exit(0);
