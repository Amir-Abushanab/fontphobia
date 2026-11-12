// Browsers in the pinned Playwright Linux image (§10.3 "Engines and platforms"): the worst case for
// rounding (Chrome on Linux at DPR 1 hints and snaps advances to whole pixels), and Firefox and
// WebKit on Linux. The image runs a Playwright browser server; the browser reaches the host's site
// through Playwright's `exposeNetwork`, so nothing on the host has to listen beyond 127.0.0.1.
// Runtimes, in order: Apple's `container` (macOS), Docker, Podman.
import { execFile, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { connect as tcpConnect } from 'node:net';
import { chromium, firefox, webkit, type Browser } from 'playwright-core';
import { freePort } from './server.ts';

export type Runtime = 'container' | 'docker' | 'podman';

const require = createRequire(import.meta.url);
const pwDir = () => realpathSync(dirname(require.resolve('playwright-core/package.json')));
export const playwrightVersion = (): string =>
  (JSON.parse(readFileSync(join(pwDir(), 'package.json'), 'utf8')) as { version: string }).version;
/**
 * The image, pinned by digest (the multi-arch index) so a re-pushed tag can't change what runs.
 * Add a digest here when playwright-core is upgraded; an unknown version falls back to the tag.
 */
const IMAGE_DIGESTS: Record<string, string> = {
  '1.64.1': 'sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f',
};
export const linuxImage = (): string => {
  const v = playwrightVersion();
  const tag = `mcr.microsoft.com/playwright:v${v}-noble`;
  return IMAGE_DIGESTS[v] ? `${tag}@${IMAGE_DIGESTS[v]}` : tag;
};

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/** The first container runtime that answers within a few seconds (a stopped Docker daemon hangs). */
export async function findRuntime(prefer?: Runtime): Promise<Runtime | undefined> {
  const order: Runtime[] = prefer
    ? [prefer]
    : process.platform === 'darwin'
      ? ['container', 'docker', 'podman']
      : ['docker', 'podman'];
  for (const r of order) {
    const probe =
      r === 'container'
        ? await run('container', ['system', 'status'], 5000)
        : await run(r, ['info', '--format', '{{.ServerVersion}}'], 5000);
    if (probe.code === 0 && (r !== 'container' || /running/i.test(probe.out))) return r;
  }
  return undefined;
}

export interface LinuxBrowsers {
  runtime: Runtime;
  image: string;
  /** Container name. */
  name: string;
  launch(engine: 'chromium' | 'firefox' | 'webkit'): Promise<Browser>;
  stop(): Promise<void>;
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = tcpConnect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });

export async function startLinuxBrowsers(
  o: { runtime?: Runtime; log?: (m: string) => void } = {},
): Promise<LinuxBrowsers> {
  const log = o.log ?? (() => {});
  const runtime = await findRuntime(o.runtime);
  if (!runtime) {
    throw new Error(
      process.platform === 'darwin'
        ? "No container runtime answered. Install Apple's `container` (github.com/apple/container) and run `container system start`, or start Docker or Podman."
        : 'No container runtime answered. Start Docker or Podman.',
    );
  }
  const image = linuxImage();
  if (!image.includes('@sha256:')) log(`warning: no pinned digest for ${image}; running it by tag`);
  const inspect =
    runtime === 'container'
      ? await run('container', ['image', 'inspect', image], 15_000)
      : await run(runtime, ['image', 'inspect', image], 15_000);
  if (inspect.code !== 0) {
    log(`pulling ${image} with ${runtime} (about 2 GB, once)`);
    const pull = await run(runtime, runtime === 'container' ? ['image', 'pull', image] : ['pull', image], 30 * 60_000);
    if (pull.code !== 0) throw new Error(`${runtime} couldn't pull ${image}: ${pull.out.trim().slice(-500)}`);
  }
  const port = await freePort();
  const name = `fontphobia-verify-${process.pid}-${port}`;
  // playwright-core is plain JS: mount the host's copy so the server speaks exactly the client's protocol.
  const args = [
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:3000`,
    // Read-only: the container can't change the host's playwright-core.
    '--mount',
    `type=bind,source=${pwDir()},target=/fontphobia/playwright-core,readonly`,
    ...(runtime === 'container' ? ['-m', '4G', '-c', '4'] : ['--ipc=host', '--init']),
    // No --unsafe: clients can't pass launch args or executable paths to the server.
    image,
    'node',
    '/fontphobia/playwright-core/cli.js',
    'run-server',
    '--port',
    '3000',
    '--host',
    '0.0.0.0',
  ];
  const started = await run(runtime, args, 120_000);
  if (started.code !== 0) throw new Error(`${runtime} run failed: ${started.out.trim().slice(-800)}`);
  const stop = async () => {
    await run(runtime, ['stop', name], 30_000);
  };
  const ws = `ws://127.0.0.1:${port}/`;
  const t0 = Date.now();
  for (;;) {
    if (await portOpen(port)) {
      // The port can accept before the server inside does; try a real connection.
      try {
        const b = await chromium.connect(ws, { timeout: 5000 });
        await b.close();
        break;
      } catch {
        /* not yet */
      }
    }
    if (Date.now() - t0 > 90_000) {
      const logs = await run(runtime, ['logs', name], 10_000);
      await stop();
      throw new Error(`The Playwright server in ${image} didn't come up:\n${logs.out.trim().slice(-800)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`${runtime}: ${image}`);
  const types = { chromium, firefox, webkit };
  return {
    runtime,
    image,
    name,
    stop,
    // Default launch options (headless, the image's default flags: the worst case for hinting).
    // Requests to the host's 127.0.0.1 go through this process, so the site server needs no other address.
    launch: (engine) => types[engine].connect(ws, { exposeNetwork: '<loopback>', timeout: 60_000 }),
  };
}

/** For a CLI that gets killed: stop the container on exit. */
export function stopOnExit(b: LinuxBrowsers): () => void {
  const kill = () => {
    try {
      spawn(b.runtime, ['stop', b.name], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* best effort */
    }
  };
  process.once('exit', kill);
  return () => process.off('exit', kill);
}
