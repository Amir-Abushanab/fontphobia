---
'fontphobia': minor
---

The CLI shows its progress and explains each step.

- The default command starts with the fontphobia wordmark and the version in a terminal (the version line alone in CI logs and pipes), so a run of an old version is easy to spot.
- In a terminal outside CI, `audit`, `verify`, `auto` and the default command ask the npm registry for the latest version in the background (one request, 2 s timeout) and print `fontphobia 0.7.0 is out; this run is 0.1.1` with the `dlx` command for the package manager in use. For a pnpm run of a release under a week old it adds what to do when `minimumReleaseAge` refuses it: run it from outside the project with `--cwd` (the publish date is fetched only when a newer version exists). `FONTPHOBIA_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` turns it off.
- The default command runs in three headed steps (Audit, Plan, Verify), each with a line on what it does. In a terminal a status line shows a spinner while the site builds and a progress bar while pages are found, loaded and compared.
- After the audit it says what the page loads were: for example `36 page loads (9 per page): 4 viewport widths (360, 768, 1280, 1920 px), then the browser's default font size set to 9 and 72 px`, and how many came from the cache. The report says "page loads" where it said "visits".
- The plan table has a `Saved` column with each face's percentage. The final line gives the median font bytes per page before and after.
- In a terminal the opt-ins are a checklist (↑/↓, space, enter) with their measured savings and what each changes. Picking any plans again and shows the new median before the write question. With `--ci`, `--write`, `--allow`, `CI` set or no terminal nothing is asked and the opt-ins are listed as before.
- Edits are shown as a line diff: kept lines as context, a changed line as its removal and its addition, long `unicode-range` values shortened to their first ranges and a count.
- Reports are colored in a terminal. `NO_COLOR`, `FORCE_COLOR` and the new `--no-color` flag control it.
- An unknown command fails with the closest command name (`Did you mean verify?`) instead of "Unused args". `fontphobia help` works like `--help`, which now lists examples and drops the `(default: true)` noise on `--no-*` flags.
