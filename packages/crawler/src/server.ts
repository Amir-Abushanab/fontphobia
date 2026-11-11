// Running a production server for SSR routes (§7.1 "Server mode", "Running servers").
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface RunningServer { url: string; output(): string; stop(): Promise<void>; pid?: number }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s"'\x1b]*/g;
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

async function responds(url: string): Promise<boolean> {
  try {
    const ctl = AbortSignal.timeout(2000);
    const r = await fetch(url, { signal: ctl, redirect: 'manual' });
    await r.body?.cancel();
    return r.status > 0;
  } catch { return false; }
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    child.once('exit', () => resolve());
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
    setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 5000).unref();
  });
}

/**
 * Start `command` in `cwd` with PORT/HOST set, and wait until it answers HTTP. The URL comes from
 * the port we chose, or from the first local URL the process prints (servers that ignore PORT,
 * or move to the next port when one is busy).
 */
export async function startServer(command: string, opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number; path?: string }): Promise<RunningServer> {
  const port = await freePort();
  let out = '';
  command = command.replaceAll('$PORT', String(port));
  const child = spawn(command, {
    cwd: opts.cwd, shell: true, detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1', NODE_ENV: 'production', BROWSER: 'none', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (d: Buffer) => { out += d.toString(); if (out.length > 200_000) out = out.slice(-100_000); };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  let exited: number | null = null;
  child.on('exit', (c) => { exited = c ?? 0; });
  child.on('error', (e) => { out += `${e.message}\n`; exited ??= 127; });
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const suffix = (opts.path ?? '/').replace(/^\/?/, '/');
  const candidates = () => [`http://localhost:${port}`, `http://127.0.0.1:${port}`, ...[...stripAnsi(out).matchAll(URL_RE)].map((m) => m[0].replace('0.0.0.0', '127.0.0.1').replace(/\/+$/, ''))];
  while (Date.now() < deadline) {
    for (const base of [...new Set(candidates())]) {
      const origin = new URL(base).origin;
      if (await responds(origin + suffix)) return { url: origin, pid: child.pid, output: () => out, stop: () => killTree(child) };
    }
    if (exited !== null) throw new Error(`\`${command}\` exited with code ${exited} before serving:\n${stripAnsi(out).trim().slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  await killTree(child);
  throw new Error(`\`${command}\` didn't answer HTTP within ${Math.round((opts.timeoutMs ?? 90_000) / 1000)} s:\n${stripAnsi(out).trim().slice(-2000)}`);
}

/** Run a build command to completion; returns its output. Production builds: NODE_ENV=production (a test runner's NODE_ENV=test would otherwise leak into the bundle). */
export function runCommand(command: string, cwd: string, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, NODE_ENV: 'production', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code: code ?? 1, output: out }));
    // It didn't start (no such cwd, no shell): a failed command, not an uncaught error.
    child.on('error', (e) => resolve({ code: 127, output: `${out}${e.message}\n` }));
  });
}
