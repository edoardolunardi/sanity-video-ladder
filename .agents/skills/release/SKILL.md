---
name: release
description: Cut a release of sanity-video-ladder with npm run release, which rolls the changelog, bumps, tags and pushes; the Release workflow then publishes to npm through trusted publishing and lists the GitHub release. Use when asked to release, publish, tag or version the package, for the first release, and to recover when a release stopped halfway.
---

# Release

One command from a clean `main`:

```sh
npm run release -- patch      # 0.1.0 -> 0.1.1
npm run release -- minor      # 0.1.0 -> 0.2.0
npm run release -- major      # 0.1.0 -> 1.0.0
npm run release -- 0.4.2      # an explicit version
```

Add `--dry-run` to see everything it would do without writing a file or touching git. Add
`--skip-tests` only when the tests have just passed on this exact commit.

No npm login and no one-time password are involved. The script ends by pushing the tag, and the tag
starts `.github/workflows/release.yml`, which publishes to npm through trusted publishing (OIDC, with
provenance) and creates the GitHub release with the changelog section as notes. A push to `main`
without a tag releases nothing.

Ask before running it: it commits and pushes.

## What happens, in order

The script:

1. **Preflight.** On `main`, clean tree, not behind `origin/main`, tag not taken.
2. **Changelog.** Reads `## [Unreleased]` in `CHANGELOG.md`. Empty means there is nothing to
   release, and it stops.
3. **Checks.** `npm run check`, `npm test`, `npm run build`.
4. **Write.** Turns the Unreleased entries into `## [x.y.z] - YYYY-MM-DD`, leaves an empty Unreleased
   above it, and runs `npm version x.y.z --no-git-tag-version`.
5. **Commit and tag.** `chore(release): x.y.z` and an annotated `vx.y.z` with the message
   `sanity-video-ladder x.y.z`. The commit passes the commitlint hook.
6. **Push.** `git push --follow-tags origin main`.

The workflow, on the tag:

7. Checks out the tag, verifies it names the version in `package.json`, runs `npm run check` and
   `npm test`.
8. `npm publish --provenance --access public`, unless that version is already on npm. `prepack`
   builds `dist/`.
9. `gh release create vx.y.z` with the output of `scripts/notes.mjs` as the notes, unless the release
   already exists.

Watch it with `gh run watch`, or on the Actions tab.

## Which bump

- **patch**: fixes only, nothing a caller would notice beyond the fix.
- **minor**: anything that adds to the API or changes what the pipeline produces. Under 0.x this is
  also where a change of contract goes (an option's meaning, the endpoint's shape).
- **major**: once 1.0 is out, a change of contract.

A change to the stored value (field names, `_key`s, the quality list) is a contract change with
existing documents in every host, and needs a migration path in the changelog whatever the bump.

Read the Unreleased section as a user of the package would and decide the bump from what is there,
not from the size of the diff.

## The first release

npm only lets a package trust a workflow once the package exists, so 0.1.0 is published by hand:

1. `npm run release -- 0.1.0` rolls the changelog, commits, tags `v0.1.0` and pushes. The Release
   workflow starts and its publish step fails: npm does not know the package yet. That is expected.
2. The maintainer publishes from the tag: `git checkout v0.1.0`, `npm login`,
   `npm publish --access public`, `git checkout main`.
3. The maintainer sets up the trusted publisher (below).
4. `gh workflow run release.yml -f tag=v0.1.0`. The publish step sees 0.1.0 on npm and skips it; the
   GitHub release is listed.

Steps 2 and 3 are the maintainer's: an agent never logs in to npm or publishes.

## One-time setup

On npmjs.com, package `sanity-video-ladder`, Settings, Trusted publisher: GitHub Actions, owner
`edoardolunardi`, repository `sanity-video-ladder`, workflow filename `release.yml`, environment left
blank. Without it the workflow's publish step fails with an authentication error and nothing else is
affected; set it up and run the workflow again for the same tag:

```sh
gh workflow run release.yml -f tag=v0.2.0
```

## When it stops halfway

The script prints `==> step` before each step, so the last heading says where it stopped.

- **Before "write"**: nothing was changed. Fix the cause (a failing check, an empty changelog, a dirty
  tree) and run it again.
- **At "commit and tag" or "push"**: the files are written and possibly committed. `git status` and
  `git log -1` show how far it got; finish by hand with the commands above, or
  `git reset --hard origin/main` and `git tag -d vx.y.z` to start over.
- **In the workflow**: the commit and the tag are pushed. Read the failed step's log, fix the cause
  (usually the trusted publisher setup), and run the workflow again for the same tag. Do not bump
  again; the version is already committed.

Never delete or move a tag that has been pushed: cut the next version instead.
