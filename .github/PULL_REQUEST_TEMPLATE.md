<!--
Every section below is required, and a workflow checks this description against this template on
every push and edit: the headings must stay as they are, each section must be written, and every
box in the checklist must be ticked. How the package is changed is in AGENTS.md and
.agents/skills/library-change.
-->

## Why

<!--
The problem, the situation a host or an editor is in, or the reason. Not what the diff does.
-->

## What changed

<!--
The change in a few sentences, which entry points it touches (/core, /storage, /server, /studio,
the CLI), and anything a reviewer should look at first.
-->

## How it was verified

<!--
The tests added or changed, and for a change to /studio or the CLI, the host it was tried in (via
yalc) and what was done there: an upload, a pick from the library, a dry run. For a change with
nothing to run (docs, the release scripts, this template) write `none` and why.
-->

## Checklist

<!--
Tick every box. A line that does not apply is still ticked, with a word on why after it, for
example "Host: no change to /studio".
-->

- [ ] `npm run check` and `npm test` pass
- [ ] Host: a change to `/studio` or the CLI was tried in a host Studio through yalc
- [ ] Boundaries: `/core`, `/storage` and `/server` import nothing from `sanity`, `react`, `@sanity/ui`, `mediabunny` or `/studio`
- [ ] Data shape: no field or `_key` of the stored video value was renamed without a migration
- [ ] README: the API tables, the examples and the caveats say what is now true
- [ ] CHANGELOG: a line under `## [Unreleased]` for anything a user of the package would notice
- [ ] Prose and comments are plain sentences in the file's voice, with no em dashes or en dashes
- [ ] Commits follow Conventional Commits, and so does the title of this pull request
