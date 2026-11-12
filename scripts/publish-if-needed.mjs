#!/usr/bin/env node
/**
 * Guarded publish: publishes only the package versions npm does not already have, driving
 * `pnpm publish` directly rather than `changeset publish`. Run via `pnpm release`; pass
 * `--dry-run` to preview. The same script as in the sibling projects (orb3d, materials3d).
 *
 * `pnpm publish` runs from the package directory, so the package's `prepack` builds `dist` and
 * copies README.md and LICENSE in, and pnpm rewrites `workspace:` ranges. npm OIDC trusted
 * publishing and provenance come from the workflow (`id-token: write`).
 *
 * What changesets/action reads: v2 does not scan stdout. It hands the publish script a file path
 * in `CHANGESETS_OUTPUT` and reads one JSON object per line from it,
 *   {"type":"git-tag","tag":"fontphobia@0.3.0","packageName":"fontphobia"}
 * then creates each tag through the GitHub API at the workflow's commit and cuts a GitHub Release
 * for it, with the package's changelog entry as the notes. The `New tag:` line is printed for
 * whoever reads the log; the file is what CI acts on. The local annotated tag is created too:
 * with `push-with-git-cli` the action pushes tags by `git push origin <tag>`, which needs it to
 * exist in this checkout.
 *
 * Also self-heals: a version that is on npm but whose git tag never reached origin (a past run
 * that published, then died before the tags were pushed) is announced again, so no release stays
 * without a tag. See restoreMissingTags.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `usage: pnpm release [--dry-run]

Publishes every non-private package under packages/ whose version is not on npm yet, creates its
git tag, and reports it to changesets/action through the CHANGESETS_OUTPUT file when set.

  --dry-run   print what would be published and which tags restored, publish nothing`;

const packagesDir = new URL('../packages/', import.meta.url);
const label = (list) => list.map((p) => `${p.name}@${p.version}`).join(', ');

/** Every non-private package under packages/, with its directory. */
function publishablePackages() {
  const out = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(new URL(`${entry.name}/package.json`, packagesDir), 'utf8'));
    } catch {
      continue; // no readable package.json in this directory
    }
    if (pkg.private || !pkg.name || !pkg.version) continue;
    out.push({ name: pkg.name, version: pkg.version, dir: fileURLToPath(new URL(`${entry.name}/`, packagesDir)) });
  }
  return out;
}

/** The `error.code` of the JSON npm still writes to stdout when a command fails, if any. */
function npmErrorCode(stdout) {
  try {
    return JSON.parse(String(stdout ?? ''))?.error?.code;
  } catch {
    return undefined;
  }
}

/** Is this exact name@version already on the npm registry? */
function isPublished(name, version) {
  try {
    // --prefer-online revalidates npm's HTTP cache instead of trusting a possibly stale local
    // packument, so a version published moments ago is still seen.
    const raw = execFileSync('npm', ['view', name, 'versions', '--json', '--prefer-online'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let versions = JSON.parse(raw);
    if (!Array.isArray(versions)) versions = [versions]; // a package with one version comes back as a bare string
    return versions.includes(version);
  } catch (err) {
    // An unknown package is npm's E404, on stderr and in the JSON it writes to stdout. Match the
    // code and not any "404": a URL or a proxy message could contain those digits too.
    if (/\bE404\b/.test(String(err?.stderr ?? '')) || npmErrorCode(err?.stdout) === 'E404') return false;
    // A network, registry or auth failure is not evidence that the version is unpublished: fail
    // loudly rather than trigger a bogus publish.
    throw err;
  }
}

/** Annotated tag at HEAD, like `changeset publish` makes; a tag that already exists only warns. */
function ensureLocalTag(tag) {
  try {
    execFileSync('git', ['tag', tag, '-m', tag], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    console.error(`warning: could not create git tag ${tag}: ${String(err?.stderr ?? err)}`);
  }
}

/**
 * Announce a tag: the local tag, the `New tag:` line for the log, and the event changesets/action
 * reads from CHANGESETS_OUTPUT. Outside the action (a laptop publish) there is no file to write.
 */
function announceTag(name, version) {
  const tag = `${name}@${version}`;
  ensureLocalTag(tag);
  console.log(`New tag: ${tag}`);
  const output = process.env.CHANGESETS_OUTPUT;
  if (output) appendFileSync(output, `${JSON.stringify({ type: 'git-tag', tag, packageName: name })}\n`);
}

/**
 * A version can be live on npm yet have no git tag or GitHub Release: a previous run published,
 * then died before changesets/action pushed the tags. Such a version never re-enters `pending`,
 * so without this pass its tag would stay lost on every future run. Announce it again here (at
 * this run's commit; the original release commit isn't knowable) so changesets/action creates the
 * tag and cuts the Release. Never fails the run.
 *
 * Releases up to 0.2.0 were tagged `v<version>` by the workflow this one replaced. Such a tag
 * counts: the version is tagged, at its real commit, and is left alone.
 */
function restoreMissingTags(onNpm, dryRun) {
  if (onNpm.length === 0) return;
  let remote;
  try {
    const raw = execFileSync('git', ['ls-remote', '--tags', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    remote = new Set(raw.split('\n').map((line) => line.split('\t')[1]).filter(Boolean).map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, '')));
  } catch (err) {
    console.error(`warning: could not list origin tags, skipping tag restore: ${String(err?.stderr ?? err)}`);
    return;
  }
  for (const p of onNpm) {
    const tag = `${p.name}@${p.version}`;
    if (remote.has(tag) || remote.has(`v${p.version}`)) continue;
    if (dryRun) {
      console.log(`(dry run) would restore missing tag ${tag}`);
      continue;
    }
    console.log(`Restoring missing tag for already-published ${tag}`);
    announceTag(p.name, p.version);
  }
}

function main(argv) {
  const unknown = argv.filter((a) => a !== '--dry-run' && a !== '--help');
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]}; flags are: --dry-run (--help for usage)`);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const pkgs = publishablePackages();
  const pending = pkgs.filter((p) => !isPublished(p.name, p.version));

  restoreMissingTags(pkgs.filter((p) => !pending.includes(p)), dryRun);

  if (pending.length === 0) {
    console.log(`Nothing to publish. Already on npm: ${label(pkgs)}`);
    return;
  }

  console.log(`Publishing: ${label(pending)}`);
  if (dryRun) {
    console.log('(dry run) skipping publish');
    return;
  }

  const published = [];
  const failed = [];
  for (const p of pending) {
    try {
      // The same call `changeset publish` makes for a pnpm workspace: from the package dir (so
      // `prepack` runs and workspace: deps get rewritten), --access public per
      // .changeset/config.json, and --no-git-checks so pnpm doesn't balk at CI's git state.
      execFileSync('pnpm', ['publish', '--access', 'public', '--no-git-checks'], { cwd: p.dir, stdio: 'inherit' });
      announceTag(p.name, p.version);
      published.push(p);
    } catch {
      // A non-zero exit is benign only if the version is already on npm (the pre-check raced a
      // concurrent publish, or misfired); anything else is a real publish failure.
      if (isPublished(p.name, p.version)) console.error(`${p.name}@${p.version} is already on npm; skipping.`);
      else failed.push(p);
    }
  }

  if (failed.length > 0) throw new Error(`Failed to publish: ${label(failed)}`);
  console.log(`Published: ${label(published)}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
