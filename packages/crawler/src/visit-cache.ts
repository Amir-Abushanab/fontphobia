// The incremental audit (M3.5): each visit is cached under its page and settings, with the sha256 of
// everything the page loaded. Before reusing a visit, every resource is fetched again over plain HTTP
// (no browser) and must hash the same; then the stored visit stands in for a new one. A content edit
// re-visits only the pages that load the edited file. Cached in .fontphobia/cache/visits/ (gitignored).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VisitOptions, VisitResult } from './visit.ts';

/** Bump when the shape of a cached visit, or what a visit records, changes. */
export const VISIT_CACHE_VERSION = 2;

interface Entry {
  v: number;
  key: string;
  /** Origin the visit was made on: the static server's port changes between runs. */
  origin: string;
  resources: NonNullable<VisitResult['resources']>;
  result: Omit<VisitResult, 'bodies' | 'resources'>;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export interface CacheStats {
  hits: number;
  misses: number;
  stored: number;
}

export class VisitCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, stored: 0 };
  private dir: string;
  private seen = new Set<string>();
  /** One fetch per URL per run: pages share CSS, scripts and fonts. */
  private fetched = new Map<string, Promise<{ sha256: string; bytes?: Uint8Array }>>();

  private meta: { chrome: string; fontphobia: string; userAgent: string; locales: string[] };
  constructor(root: string, meta: { chrome: string; fontphobia: string; userAgent: string; locales: string[] }) {
    this.dir = join(root, '.fontphobia', 'cache', 'visits');
    this.meta = meta;
  }

  keyOf(url: string, vo: Omit<VisitOptions, 'locales' | 'bodyCache'>): string {
    const u = new URL(url);
    return sha(
      JSON.stringify({
        v: VISIT_CACHE_VERSION,
        path: u.pathname + u.search,
        viewport: vo.viewport,
        height: vo.height,
        fontSize: vo.fontSize,
        textScale: vo.textScale,
        maxPlatformNodes: vo.maxPlatformNodes,
        chrome: this.meta.chrome,
        fontphobia: this.meta.fontphobia,
        locales: this.meta.locales,
      }),
    );
  }

  private fetchHash(url: string): Promise<{ sha256: string; bytes?: Uint8Array }> {
    let p = this.fetched.get(url);
    if (!p) {
      p = (async () => {
        try {
          const r = await fetch(url, {
            headers: { 'user-agent': this.meta.userAgent, 'accept-language': 'en-US' },
            signal: AbortSignal.timeout(15_000),
          });
          if (r.status >= 400) return { sha256: `http-${r.status}` };
          const bytes = new Uint8Array(await r.arrayBuffer());
          return { sha256: sha(bytes), bytes };
        } catch {
          return { sha256: 'unreachable' };
        }
      })();
      this.fetched.set(url, p);
    }
    return p;
  }

  /** The stored visit if every resource it loaded is unchanged, with font bodies refetched. */
  async get(key: string, origin: string): Promise<VisitResult | undefined> {
    const file = join(this.dir, `${key}.json`);
    let e: Entry;
    try {
      e = JSON.parse(readFileSync(file, 'utf8')) as Entry;
    } catch {
      this.stats.misses++;
      return undefined;
    }
    if (e.v !== VISIT_CACHE_VERSION || e.key !== key) {
      this.stats.misses++;
      return undefined;
    }
    const move = (s: string) => (e.origin === origin ? s : s.split(e.origin).join(origin));
    const bodies = new Map<string, Uint8Array>();
    const checks = await Promise.all(
      e.resources.map(async (r) => {
        const now = await this.fetchHash(move(r.url));
        if (now.sha256 !== r.sha256) return false;
        if (r.font && now.bytes) bodies.set(now.sha256, now.bytes);
        return true;
      }),
    );
    if (!checks.every(Boolean)) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    this.seen.add(key);
    const result = e.origin === origin ? e.result : (JSON.parse(move(JSON.stringify(e.result))) as Entry['result']);
    return { ...result, bodies, resources: e.resources };
  }

  put(key: string, origin: string, r: VisitResult): void {
    this.seen.add(key);
    if (!r.visit || !r.resources || r.error) return;
    mkdirSync(this.dir, { recursive: true });
    const { visit, status, finalUrl, links } = r;
    const e: Entry = {
      v: VISIT_CACHE_VERSION,
      key,
      origin,
      resources: r.resources,
      result: { visit, status, finalUrl, links },
    };
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(e));
    this.stats.stored++;
  }

  /** Drop entries this run didn't use (pages that are gone, settings that changed). */
  prune(): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir))
      if (f.endsWith('.json') && !this.seen.has(f.slice(0, -5))) rmSync(join(this.dir, f), { force: true });
  }
}

export function clearVisitCache(root: string): void {
  rmSync(join(root, '.fontphobia', 'cache', 'visits'), { recursive: true, force: true });
}
