# Working on sanity-video-ladder

sanity-video-ladder gives a Sanity Studio browser-transcoded video renditions, uploaded straight to an
S3-compatible bucket. One npm package, several entry points, no root export. The editor's browser does
the transcoding; the host's server only presigns, lists and deletes. This file is the one place agents
read instructions from; the skills under `.agents/skills/` hold the step-by-step procedures it points to.

## Layout

| Path                    | What it is                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/core/`             | `sanity-video-ladder/core`: types, tiers, `pickRendition`, `videoSources`, the shrink rule, the GROQ projection. `layout.ts` is the naming contract every other part reads (file names, revisions, `_key`s, the cache header). |
| `src/storage/`          | `sanity-video-ladder/storage`: `createStorage`, `r2Storage`, the key layout (`keys.ts`) and the listing parser (`list.ts`). |
| `src/server/`           | `sanity-video-ladder/server`: `createVideoHandler`, the endpoint the Studio calls.                     |
| `src/studio/`           | `sanity-video-ladder/studio`: the plugin, the schema, the upload input (`input/`), the library tool and picker (`library/`). |
| `src/cli/`              | The `sanity-video-ladder renditions` command. `plan.ts` is its pure, tested part.                      |
| `src/fixtures.ts`       | Values the tests share. Not built.                                                                     |
| `scripts/`              | `release.mjs` cuts a release; `notes.mjs` and `pull-request.mjs` serve the workflows.                   |
| `.github/workflows/`    | `pull-request.yml` and `pull-request-description.yml` check every pull request; `release.yml` publishes a tag to npm. |
| `.github/ISSUE_TEMPLATE/` | The bug report and feature request forms.                                                            |
| `.github/PULL_REQUEST_TEMPLATE.md` | The sections every pull request description must have.                                     |
| `.agents/skills/`       | Procedures: changing the package, releasing.                                                           |

## Commands

```sh
npm run check        # tsc and Biome lint
npm run format       # Biome, with fixes
npm test             # node:test on src/**/*.test.ts, run as TypeScript by Node itself
npm run build        # dist/, from tsc
npm run release -- patch|minor|major   # see .agents/skills/release
```

Node is pinned in `.nvmrc` (24.15.0) with `engine-strict`. Source files import their siblings with
`.ts` and `.tsx` extensions: `tsc` rewrites them to `.js` on emit (`rewriteRelativeImportExtensions`),
and Node runs the tests on the sources with its built-in type stripping, which is why
`erasableSyntaxOnly` is on (no enums, no parameter properties, no namespaces).

## What must stay true

- **Import boundaries.** `/core`, `/storage` and `/server` never import `sanity`, `react`, `@sanity/ui`,
  `@sanity/icons`, `styled-components`, `mediabunny`, or anything from `src/studio`. `/core` imports no
  Node built-ins either, since it runs on sites and in browsers. `/studio` and the CLI may import the
  others. After a build, both of these print nothing:
  `grep -REn 'from "(sanity|react|@sanity/ui|@sanity/icons|mediabunny)' dist/core dist/storage dist/server`
  and `grep -rn 'from "node:' dist/core`.
- **No framework opinions.** Nothing names a CSS framework, a breakpoint set or a site framework. Sources are
  chosen with native media conditions the site writes (`videoSources`), or by the site's own logic
  with `pickRendition`.
- **Config is injected.** Nothing reads `process.env`. The host passes its storage config to the
  endpoint and writes the CLI's config file.
- **`authorize` is required** in `createVideoHandler`, with no default, so an endpoint never ships open.
- **Response shape.** Success is `{ ok: true, ... }`, failure `{ ok: false, error }`, every response
  `cache-control: no-store`. An `authorize` denial is returned unchanged.
- **Key layout and caching.** One fresh folder per upload; the original and `poster.webp` written once
  per folder; every rung under a random revision; every object `Cache-Control: public,
  max-age=31536000, immutable`, signed into the upload URL. No key is ever overwritten with new content.
- **The stored value is a contract with existing documents.** Field names (`renditions`, `quality`,
  `url`, `poster`, `placeholder`, `dimensions`, `playback`), the `rendition` member type and the
  `_key`s (`original`, `mp4-<height>`) never change without a migration. Neither do the quality list
  order or values, which typegen turns into types in host projects.
- **Deletion is gated on usage.** A video whose references are unknown (the scan failed or is still
  loading) is never deletable, and the usage scan pages through every document rather than stopping
  at a limit.
- **MediaBunny loads lazily.** The input reaches `input/media.ts` through `import()` only when an
  editor picks a file, so the Studio's first load does not carry it.
- **`"use client"`** opens every `src/studio/**/*.tsx` file. Next embeds the Studio as a client route.

## How to change behaviour

1. Write or update the test first where the code is pure (`/core`, `/storage`, `/server`, `cli/plan.ts`,
   `studio/tiers.ts`). The Studio UI has no tests here; it is verified in a host.
2. Change the code. Comments explain why, in full sentences, in the voice of the existing ones.
3. Run `npm run check` and `npm test`. For a change to `/studio` or the CLI, try it in a host project
   through yalc (see `.agents/skills/library-change`).
4. Update the README (the API tables, the examples, the caveats) and add a line under
   `## [Unreleased]` in `CHANGELOG.md` for anything a user of the package would notice.
5. The whole checklist is in `.agents/skills/library-change`.

## Conventions

- **Commits** follow Conventional Commits, enforced by a hook: `feat`, `fix`, `docs`, `ci`, `build`,
  `chore`, `refactor`, `test`; header at most 72 characters, lowercase scope, a blank line before the
  body. The body explains why, not what. No attribution lines, no tool names, no co-author trailers.
- **Do not commit or push unless asked**, and ask again for each commit or push.
- **Pull requests** follow `.github/PULL_REQUEST_TEMPLATE.md`: why, what changed, how it was verified,
  and a ticked checklist. The Pull request workflow rejects a description that strays from it, a title
  or commit that is not Conventional Commits, and a failing check or test.
- **Prose** (docs, comments, commit messages, UI copy) uses plain sentences. No em dashes or en
  dashes: use a period, a comma, a colon or parentheses instead. Hyphens in compound words are fine.
  UI copy says "storage" or "bucket", never a provider's name.
- **Formatting** is Biome's, run by the pre-commit hook on staged files. TypeScript is strict.

## Releasing

`npm run release -- patch|minor|major` runs the checks and the tests, rolls the changelog, bumps,
commits, tags and pushes. The tag starts the Release workflow, which publishes to npm through trusted
publishing and lists the GitHub release; no npm login or one-time password is involved. Try
`--dry-run` first. Details and recovery steps in `.agents/skills/release`.
