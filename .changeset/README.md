# Changesets

Run `pnpm changeset` to describe a change, `pnpm run version` to apply the pending
changesets to the package version and changelog (`run` matters: bare `pnpm version` is
pnpm's own version builtin, not this repo's script), and `pnpm release` to build and
publish.

Every changeset names `fontphobia`, the one published package. `@fontphobia/core` and
`@fontphobia/crawler` are private and bundled into it, so a change to either is a change
to `fontphobia`. Without the prompts:

```sh
pnpm changeset --patch fontphobia -m "What changed, as the changelog should say it."
```

While the version is 0.x, use `minor` for a new feature or a change that breaks existing
use, and `patch` for a fix. `major` releases 1.0.0.

See the [changesets docs](https://github.com/changesets/changesets) for details.
