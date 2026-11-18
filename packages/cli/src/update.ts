// A one-line notice when a newer fontphobia is published, so a run of an old pinned version (a
// `dlx fontphobia@0.1.1` in shell history) is noticed before its results are trusted. One request
// to the npm registry, in the background, with a short timeout; never in CI or without a terminal.

const REGISTRY = 'https://registry.npmjs.org/fontphobia/latest';
const CHANGELOG = 'https://github.com/Amir-Abushanab/fontphobia/blob/main/packages/cli/CHANGELOG.md';

/** -1, 0 or 1 for major.minor.patch; a prerelease suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split('.')
      .map((x) => Number(x) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Whether to ask the registry: an interactive terminal, not CI, not turned off. */
export function updateCheckEnabled(env: NodeJS.ProcessEnv, live: boolean): boolean {
  return live && !env.CI && !env.FONTPHOBIA_NO_UPDATE_CHECK && !env.NO_UPDATE_NOTIFIER;
}

/** The latest published version, or undefined when the registry doesn't answer in time. */
export async function latestVersion(fetchImpl: typeof fetch = fetch, timeoutMs = 2000): Promise<string | undefined> {
  try {
    const r = await fetchImpl(REGISTRY, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return undefined;
    const v = ((await r.json()) as { version?: unknown }).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The command that runs `version`, for the package manager this run came from. */
export function runCommand(version: string, userAgent = ''): string {
  const pm = userAgent.split('/')[0];
  if (pm === 'npm') return `npx fontphobia@${version}`;
  if (pm === 'yarn') return `yarn dlx fontphobia@${version}`;
  if (pm === 'bun') return `bunx fontphobia@${version}`;
  return `pnpm dlx fontphobia@${version}`;
}

/** The notice for `current` when `latest` is newer. */
export function updateNotice(current: string, latest: string | undefined, userAgent?: string): string | undefined {
  if (!latest || compareVersions(current, latest) >= 0) return undefined;
  return `fontphobia ${latest} is out; this run is ${current}. Run \`${runCommand(latest, userAgent)}\` for the current version (changes: ${CHANGELOG}).`;
}
