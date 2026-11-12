import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function filesIn(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => (entry.isDirectory() ? filesIn(join(root, entry.name)) : [join(root, entry.name)]))
    .toSorted();
}
export function sourceFingerprint(root) {
  const files = Object.fromEntries(
    filesIn(root)
      .filter((file) => /\.(?:html|css|js|jpg|woff2)$/.test(file))
      .map((file) => [relative(root, file).split('\\').join('/'), sha256(readFileSync(file))]),
  );
  return { sha256: sha256(JSON.stringify(files)), files };
}
