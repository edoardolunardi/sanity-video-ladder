---
name: library-change
description: The checklist for changing sanity-video-ladder, from the test through a check in a host Studio to the docs. Use for any feature, fix or refactor of the plugin, the endpoint, the storage, the site helpers or the CLI, so the import boundaries, the stored-value contract, the README and the changelog all stay true.
---

# Change the package

A change is done when a test shows it (or, for the Studio, a host shows it), `npm run check` and
`npm test` pass, the README says it and the changelog records it.

## 1. Start from a test

The pure parts carry the tests, next to the code:

| Part                    | Tests                                                  |
| ----------------------- | ------------------------------------------------------ |
| Picking and sources     | `src/core/renditions.test.ts`, `src/core/sources.test.ts` |
| Naming and layout       | `src/core/layout.test.ts`, `src/storage/keys.test.ts`  |
| Listing the bucket      | `src/storage/list.test.ts`                             |
| S3 calls                | `src/storage/storage.test.ts`, with a fake `send`      |
| The endpoint            | `src/server/handler.test.ts`, with a fake storage      |
| Per-field tiers         | `src/studio/tiers.test.ts`                             |
| The CLI's plan          | `src/cli/plan.test.ts`                                 |

Write the failing test first, or run the existing one, so the current behaviour is known:

```sh
node --test src/core/sources.test.ts
```

Logic the Studio needs and React does not belongs in a plain `.ts` module (as `tiers.ts` and
`library/utils.ts` are), where it can be tested without a browser.

## 2. Keep the boundaries

`/core`, `/storage` and `/server` never import `sanity`, `react`, `@sanity/ui`, `@sanity/icons`,
`mediabunny` or `src/studio`, and `/core` imports no Node built-in. Anything both sides need goes
in `/core` (`layout.ts` holds the names every part writes and reads). A host that only serves video
must never install the Studio's weight into its server bundle.

Nothing in the package names a CSS framework or a breakpoint set. Sites choose sources with native
media conditions, or with their own logic over `pickRendition`.

## 3. Respect the stored value

Existing documents in every host hold the value the Studio wrote: `renditions[]` of
`{ _key, _type: "rendition", quality, url, poster }`, `placeholder`, `dimensions`, `playback`. The
`_key`s are `original` and `mp4-<height>` from the Studio, random from the CLI. Renaming a field or
a key, or reordering or changing the quality list (typegen turns it into types in the hosts), breaks
those documents. A change that needs it needs a migration and says so in the changelog.

Object keys follow the same rule: one folder per upload, a fresh revision per rung, nothing ever
overwritten, the immutable cache header signed into every upload.

## 4. Write comments in the file's voice

Comments explain why in full sentences and avoid restating the code. No em dashes or en dashes. UI
copy says "storage" or "bucket", never a provider.

## 5. Verify

```sh
npm run check    # types and lint
npm test         # every src/**/*.test.ts
npm run build    # and the boundary greps from AGENTS.md
```

**A change to `/studio` or the CLI is verified in a host**, since neither has UI tests here:

```sh
npm run build && npx yalc publish            # here
npx yalc add sanity-video-ladder             # in the host project
npx yalc update sanity-video-ladder          # in the host, after each later publish here
```

In the host's Studio: upload a new video (the probe says Ready, the ladder transcodes, the field
fills, every rung has a poster), pick one from the library (playback kept), open the Videos tool
(usage counts, the Unused filter, details, a download, deleting a test upload). For the CLI, a
`--dry-run` against the host's dataset. `yalc` writes `.yalc/` and `yalc.lock` into the host and
rewrites its dependency: none of that is ever committed there; `npx yalc remove sanity-video-ladder`
undoes it.

## 6. Record it

- `README.md`: the API tables and the examples for anything that moved, the caveats if a limitation
  appeared, "How it works" if the pipeline changed.
- `CHANGELOG.md`: a line under `## [Unreleased]`, in the past tense of what changed for a user of the
  package, under `### Added`, `### Changed`, `### Fixed` or `### Removed`.

## 7. Commit

Conventional Commits, header at most 72 characters, body explaining why. The hooks lint staged files
and the message. Do not commit or push unless asked.

A pull request follows `.github/PULL_REQUEST_TEMPLATE.md`, section by section, with every box of the
checklist ticked. The Pull request workflow checks the description against the template and fails on
a missing or empty section, a placeholder or an unticked box; run the same check by hand with
`node scripts/pull-request.mjs body.md`.
