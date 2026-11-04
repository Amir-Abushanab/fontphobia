// Built-in static server for build output (§7.1): directory indexes, clean URLs, 404.html,
// optional SPA fallback. Binds 127.0.0.1 on a free port.
import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
  '.map': 'application/json', '.data': 'application/octet-stream',
};

export interface StaticServer { url: string; close(): Promise<void>; server: Server }

export interface ServeOptions {
  /** Serve index.html for unknown paths with status 200 (Vite SPA, Rsbuild). */
  spaFallback?: boolean;
  /** URL prefix the site is built for (e.g. "/docs/" for base paths). */
  base?: string;
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

export function resolveStatic(root: string, pathname: string): string | undefined {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return undefined; }
  const abs = normalize(join(root, rel));
  if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
  if (rel.endsWith('/')) return isFile(join(abs, 'index.html')) ? join(abs, 'index.html') : undefined;
  if (isFile(abs)) return abs;
  if (isFile(abs + '.html')) return abs + '.html';
  if (isFile(join(abs, 'index.html'))) return join(abs, 'index.html');
  return undefined;
}

export function serveStatic(root: string, opts: ServeOptions = {}): Promise<StaticServer> {
  const base = (opts.base ?? '/').replace(/\/?$/, '/');
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let p = u.pathname;
    if (base !== '/' && p.startsWith(base)) p = '/' + p.slice(base.length);
    // Like most static hosts: /about → /about/ when only about/index.html exists.
    if (!p.endsWith('/') && !extname(p) && !resolveStatic(root, p + '.html') && resolveStatic(root, p + '/')) {
      res.writeHead(301, { location: (base === '/' ? '' : base.slice(0, -1)) + p + '/' + u.search }).end();
      return;
    }
    let file = resolveStatic(root, p);
    let status = 200;
    if (!file && opts.spaFallback && !extname(p)) file = resolveStatic(root, '/');
    if (!file) { status = 404; file = resolveStatic(root, '/404.html') ?? resolveStatic(root, '/404/'); }
    if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(status, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}${base}`, server, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
