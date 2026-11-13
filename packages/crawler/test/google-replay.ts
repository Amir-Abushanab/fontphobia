// A local stand-in for Google Fonts, so the site tests don't depend on what fonts.googleapis.com and
// fonts.gstatic.com answer on the day, or on how fast. It serves the responses recorded in
// fixtures/google-fonts/ and sends this process's traffic for the two hosts to itself:
//
//   - Chrome, by `--host-resolver-rules` on every `chromium.launch` (pages the crawler and verify load);
//   - Node, by replacing `tls.connect` and `dns.lookup` for the two hosts (core's `fetch`, and
//     Playwright's `route.fetch`, which verify uses to snapshot third-party fonts).
//
// Import this file before anything that loads playwright-core: Playwright keeps its own reference to
// `dns.lookup` when it loads.
//
// A request with no recording fails the test that made it (`misses`). `FONTPHOBIA_RECORD_GOOGLE=1`
// asks Google instead and saves the answer; commit what it writes. Responses are stored by URL only.
// Google answers by user agent, and every request here carries Chrome's, so one recording per URL is
// enough. A framework that fetches from Google while it builds (next/font/google, the Astro and Nuxt
// font providers) does so in its own process, which this does not reach.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const dir = fileURLToPath(new URL('../../../fixtures/google-fonts/', import.meta.url));
const indexFile = join(dir, 'responses.json');
const recording = !!process.env.FONTPHOBIA_RECORD_GOOGLE;

type Recorded = { status: number; type: string; file: string };
type Upstream = { direct?: boolean };

let port: number | undefined;

// Installed once, at import. Both do nothing until the server listens.
const connect = tls.connect;
tls.connect = function (this: unknown, ...args: unknown[]) {
  const o = args[0] as (tls.ConnectionOptions & Upstream) | undefined;
  if (port !== undefined && o && typeof o === 'object' && !o.direct && HOSTS.has(o.servername ?? o.host ?? ''))
    args[0] = { ...o, host: '127.0.0.1', port, rejectUnauthorized: false };
  return Reflect.apply(connect, this, args);
} as typeof tls.connect;

const lookup = dns.lookup;
dns.lookup = function (this: unknown, ...args: unknown[]) {
  const host = args[0];
  const done = args.at(-1) as (e: null, address: unknown, family?: number) => void;
  if (port === undefined || typeof host !== 'string' || !HOSTS.has(host) || typeof done !== 'function')
    return Reflect.apply(lookup, this, args);
  const all = typeof args[1] === 'object' && !!(args[1] as dns.LookupOptions).all;
  process.nextTick(() => (all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)));
  return {};
} as typeof dns.lookup;

/** Google's own answer, past the redirection above. */
function upstream(url: string, userAgent: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions & Upstream = { headers: { 'user-agent': userAgent }, direct: true, lookup };
    https
      .get(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? 'application/octet-stream'),
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

export interface GoogleReplay {
  /** URLs asked for that have no recording. A test that caused one should fail. */
  misses: string[];
  close(): Promise<void>;
}

export async function startGoogleReplay(): Promise<GoogleReplay> {
  const index: Record<string, Recorded> = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
  const misses: string[] = [];

  // A certificate for this run. Chrome is told to ignore that nothing signed it, and so is Node above.
  const tmp = mkdtempSync(join(tmpdir(), 'fontphobia-google-'));
  let key: Buffer, cert: Buffer;
  try {
    const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=fonts.googleapis.com'];
    args.push('-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'));
    execFileSync('openssl', args, { stdio: 'ignore' });
    key = readFileSync(join(tmp, 'key.pem'));
    cert = readFileSync(join(tmp, 'cert.pem'));
  } catch (e) {
    throw new Error(
      `the Google Fonts stand-in needs the openssl command for its certificate: ${(e as Error).message}`,
      {
        cause: e,
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const record = async (url: string, userAgent: string): Promise<Recorded | undefined> => {
    const r = await upstream(url, userAgent);
    if (r.status !== 200) return undefined;
    const ext = /css/.test(r.type) ? 'css' : (/\.(\w{3,5})$/.exec(new URL(url).pathname)?.[1] ?? 'bin');
    const file = `${createHash('sha256').update(r.body).digest('hex').slice(0, 16)}.${ext}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), r.body);
    index[url] = { status: r.status, type: r.type, file };
    const sorted = Object.fromEntries(Object.entries(index).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(indexFile, JSON.stringify(sorted, null, 2) + '\n');
    return index[url];
  };

  const pending = new Map<string, Promise<Recorded | undefined>>();
  const server = https.createServer({ key, cert }, (req, res) => {
    const url = `https://${req.headers.host}${req.url}`;
    void (async () => {
      let hit = index[url];
      if (!hit && recording) {
        let p = pending.get(url);
        if (!p) pending.set(url, (p = record(url, String(req.headers['user-agent'] ?? '')).catch(() => undefined)));
        hit = await p;
      }
      if (!hit) {
        misses.push(url);
        res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        res.end(`no recording of ${url}; record it with FONTPHOBIA_RECORD_GOOGLE=1`);
        return;
      }
      res.writeHead(hit.status, {
        'content-type': hit.type,
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=86400',
      });
      res.end(readFileSync(join(dir, hit.file)));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  // Every Chrome this process starts from here on. Imported late, after the `dns.lookup` above is in place.
  const { chromium } = await import('playwright-core');
  const launch = chromium.launch;
  const to = `127.0.0.1:${port}`;
  chromium.launch = function (this: unknown, o: Parameters<typeof launch>[0] = {}) {
    return Reflect.apply(launch, this, [
      {
        ...o,
        args: [
          ...(o.args ?? []),
          `--host-resolver-rules=${[...HOSTS].map((h) => `MAP ${h} ${to}`).join(', ')}`,
          '--ignore-certificate-errors',
        ],
      },
    ]);
  } as typeof launch;

  return {
    misses,
    async close() {
      chromium.launch = launch;
      port = undefined;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
