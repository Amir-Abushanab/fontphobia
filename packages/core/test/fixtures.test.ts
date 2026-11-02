import { expect, test } from 'vitest';
import { PINNED, fixture, sha256 } from './helpers.ts';

test.each(Object.entries(PINNED))('fixture %s matches its pinned sha256', (name, hash) => {
  expect(sha256(fixture(name))).toBe(hash);
});
