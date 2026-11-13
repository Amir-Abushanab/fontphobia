# fontphobia in CI

Three GitHub Actions workflows. Pin the version you ran `build --write` with: the manifest records it, and `check` prints the matching command when the subsets need a rebuild.

## 1. Check every pull request

Static: no browser, no network. Fails when the built site would render differently from what the subsets cover (a new character no file has, an edited `@font-face`, a dropped feature).

```yaml
# .github/workflows/fonts.yml
name: Fonts
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm dlx fontphobia@0.3.0 check
```

Skip this if a [framework integration](../README.md#keeping-the-subsets-up-to-date) already runs `check` in your build.

## 2. Check production on a schedule

Exact mode: crawls the live site in Chrome (every runner image has it) and compares what each face draws with its files. It catches what the repo can't see: CMS content, A/B variants, user-generated text.

```yaml
# .github/workflows/fonts-production.yml
name: Fonts (production)
on:
  schedule: [{ cron: '0 6 * * 1' }] # Mondays, 06:00 UTC
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: pnpm dlx fontphobia@0.3.0 check --url https://example.com
```

## 3. Verify on Windows and Linux

Run this when fonts change (after `build --write`, or on a pull request that touches the subsets). Windows and Linux hint and rasterize differently from macOS, so a comparison there covers what a Mac can't. Diff images are uploaded when something differs.

```yaml
# .github/workflows/fonts-verify.yml
name: Fonts (verify)
on:
  pull_request:
    paths: ['.fontphobia/manifest.json']
jobs:
  verify:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # Linux also runs the worst case for rounding: Chrome in the pinned Playwright image (Docker) at DPR 1, hinting on.
      - run: pnpm dlx fontphobia@0.3.0 verify ${{ runner.os == 'Linux' && '--hinting' || '' }}
        shell: bash
      - if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: fontphobia-verify-${{ matrix.os }}
          path: .fontphobia/verify
```

`verify` builds the site itself (it finds the build command from the framework, or use `build` in the config) and serves it. For an SSR site, set `start` in the config to the production server command.

## 4. Auto mode

With `fontphobia auto` there are no committed subsets to check. The output is subset after every build, and each run checks its own files without a browser. Add `--verify` where Chrome is available to also compare the pages before and after; GitHub's runner images have Chrome.

```yaml
# .github/workflows/deploy.yml (the build job)
- run: pnpm install --frozen-lockfile
- run: pnpm build
- run: pnpm dlx fontphobia@0.3.0 auto --verify
- if: failure()
  uses: actions/upload-artifact@v7
  with:
    name: fontphobia-verify
    path: .fontphobia/verify
# deploy the output directory from here
```

`auto --crawl` keeps its visit cache in `.fontphobia/cache`. Restoring that directory between runs (with `actions/cache`) means a page is visited again only when something it loads changed.
