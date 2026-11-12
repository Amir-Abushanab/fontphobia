// Writes a crawl's usage.json as the planner's golden input (fixtures/plans/<name>/usage.json).
import { mkdirSync, writeFileSync } from 'node:fs';
import { canonicalJson } from '@fontphobia/core';

export function writeGoldenUsage(name: string, usage: unknown) {
  const dir = new URL(`../../../fixtures/plans/${name}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  // Versions vary by machine; the planner doesn't read them.
  const u = {
    ...(usage as Record<string, unknown>),
    meta: { ...(usage as { meta: object }).meta, chrome: 'golden', fontphobia: 'golden' },
  };
  writeFileSync(new URL('usage.json', dir), canonicalJson(u));
}
