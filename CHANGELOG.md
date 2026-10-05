# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-05

### Added

- `videoLadder()`, a Sanity Studio plugin that registers a video object type whose input probes a
  picked file, extracts a poster and a blur placeholder, transcodes a ladder of H.264 MP4 rungs in the
  editor's browser with MediaBunny, and uploads everything straight to the bucket. The tiers are
  configurable (`[240, 720]` by default), and a field can pick its own with `options: { tiers }`.
- The "Videos" tool and `VideoLibraryPicker`: every video in the bucket, where each is used, reuse in
  another field, per-file downloads, and deletion of videos nothing uses.
- `createVideoHandler()`, the endpoint the Studio talks to, for any runtime with the Fetch API. It
  presigns uploads and downloads, lists and deletes, and needs an `authorize` function.
- `createStorage()` and the `r2Storage()` preset, for any S3-compatible bucket. Upload URLs sign the
  content type and the immutable cache header, so an object can only be stored with both.
- `videoSources()`, which reads a `sizes`-style string such as
  `"(min-width: 48rem) original, 720"` into one `<source>` per media condition, along with
  `pickRendition()`, `videoAspectRatio()`, `hasRenditions()` and `VIDEO_PROJECTION`.
- The `sanity-video-ladder renditions` command, which adds, re-encodes or prunes rungs of existing
  videos with ffmpeg, configured by a `video-ladder.config.ts` in the host project.
