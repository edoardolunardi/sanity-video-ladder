# sanity-video-ladder

Browser-transcoded video renditions for Sanity, uploaded straight to S3-compatible storage.

An editor picks a video in the Studio. Their browser probes it, extracts a poster and a blur
placeholder, transcodes a ladder of smaller H.264 MP4 rungs with [MediaBunny](https://mediabunny.dev)
(WebCodecs), and uploads the untouched original, every rung and every poster straight to your bucket
through presigned URLs. The field fills itself. Your server never transcodes and never sees the bytes:
it only presigns, lists and deletes.

- **No transcoding server.** The work happens in the editor's tab. The endpoint you host is a few
  lines and needs no CPU, no queue and no temp storage.
- **Any S3-compatible bucket.** Cloudflare R2 has a preset; Amazon S3, MinIO, Backblaze B2, Tigris
  and DigitalOcean Spaces take the same config. Videos are served from your own domain.
- **A ladder you choose.** The tiers are yours (`[240, 720]` by default), and a field can pick its
  own subset. A rung is never larger than its source, and a rung that comes out bigger than the file
  above it is dropped.
- **The site picks the file.** `videoSources` turns a `sizes`-style string into one `<source>` per
  media condition, or you call `pickRendition` and build the markup yourself. No framework, no
  breakpoint names.
- **A library tool.** Browse every video in the bucket, see where each is used, reuse one in another
  field, download a rendition, delete what nothing uses.
- **A CLI for the rest.** `sanity-video-ladder renditions` adds or re-encodes rungs of existing videos
  with ffmpeg, without uploading again.
- **Cached forever, safely.** Every object is written once under a key that never changes content,
  with `Cache-Control: public, max-age=31536000, immutable`.

## Install

```sh
npm install sanity-video-ladder
```

The Studio entry needs `sanity` 6, `react` 19, `@sanity/ui` 4, `@sanity/icons` 5 and
`styled-components` 6, which a Studio already has. Every entry needs `@sanity/client` 7 or later.

## Use

Four pieces: the plugin in the Studio, an endpoint on your server, a component on your site, and,
when you need it, the CLI.

### In the Studio

```ts
// sanity.config.ts
import { defineConfig } from "sanity";
import { videoLadder } from "sanity-video-ladder/studio";

export default defineConfig({
  // ...
  // The input sends the editor's token to your endpoint, which needs token auth to read it.
  auth: { loginMethod: "token" },
  plugins: [videoLadder({ apiVersion: "2026-01-01" })],
});
```

This registers a `video` object type and a "Videos" tool. Use the type in any document:

```ts
defineField({ name: "video", type: "video" });

// A field can pick its own rungs from the plugin's tiers.
defineField({ name: "hero", type: "video", options: { tiers: [720, 1080] } });
```

The plugin's `tiers` is every rung a field may produce, and the ladder of a field that sets none.
A field's `options.tiers` must come from that list, since stored qualities are validated against it:
for the hero above, the plugin needs `videoLadder({ apiVersion, tiers: [240, 720, 1080] })`.

### The endpoint

The Studio talks to one `POST` endpoint on your site. `createVideoHandler` returns a
`(request: Request) => Promise<Response>`, so it fits any runtime with the Fetch API. `authorize` is
required: return `null` to let a request through, or a `Response` to deny it. Check the editor's
Sanity token there, for example by asking Sanity who it belongs to.

```ts
// Next.js: app/api/video/route.ts
import { createVideoHandler } from "sanity-video-ladder/server";
import { r2Storage } from "sanity-video-ladder/storage";
import { authorizeStudioRequest } from "@/lib/auth";

export const POST = createVideoHandler({
  authorize: authorizeStudioRequest,
  storage: r2Storage({
    accountId: process.env.R2_ACCOUNT_ID!,
    bucket: process.env.R2_BUCKET!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL!,
  }),
});
```

```ts
// Astro: src/pages/api/video.ts
import type { APIRoute } from "astro";
import { createVideoHandler } from "sanity-video-ladder/server";
import { r2Storage } from "sanity-video-ladder/storage";
import { authorizeStudioRequest } from "~/lib/auth";

export const prerender = false;

const handler = createVideoHandler({ authorize: authorizeStudioRequest, storage: r2Storage({ /* ... */ }) });

export const POST: APIRoute = ({ request }) => handler(request);
```

The storage config is checked on the first request, not at import, so a build without the
environment set still succeeds; a request then gets a `500` naming the missing field.

### On the site

Query the field with `VIDEO_PROJECTION`, then turn its renditions into `<source>` elements with
`videoSources`:

```ts
import { VIDEO_PROJECTION } from "sanity-video-ladder/core";

const query = `*[_type == "work"]{ title, "video": video{ ${VIDEO_PROJECTION} } }`;
```

`videoSources(renditions, rules)` reads `rules` the way a browser reads an `<img sizes>` attribute,
with a tier where `sizes` has a width: each entry is a media condition and a tier, the first matching
condition wins, and the entry without a condition is the fallback.

```ts
videoSources(video.renditions, "(min-width: 64rem) original, (min-width: 48rem) 720, 240");
// [
//   { media: "(min-width: 64rem)", src: ".../original.mp4" },
//   { media: "(min-width: 48rem)", src: ".../720p-3b91c0de.mp4" },
//   { src: ".../240p-77a0e1f2.mp4" },
// ]
```

A tier resolves to the smallest rung at or above it, else the original, so a clip too small for a
rung still plays. The conditions are passed through as written, so they can be anything a media query
can say. Most slots need just one tier (`"720"`), and a breakpoint only where one element spans very
different sizes.

```tsx
// React
import { videoAspectRatio, videoSources, type VideoValue } from "sanity-video-ladder/core";

export function SanityVideo({ video, quality = "720" }: { video: VideoValue; quality?: string }) {
  const playback = video.playback ?? {};

  return (
    <video
      poster={video.placeholder ?? undefined}
      autoPlay={playback.autoplay ?? true}
      muted={playback.muted ?? true}
      loop={playback.loop ?? true}
      controls={playback.controls ?? false}
      playsInline
      style={{ aspectRatio: videoAspectRatio(video), width: "100%" }}
    >
      {videoSources(video.renditions, quality).map((source) => (
        <source key={source.src} src={source.src} media={source.media} />
      ))}
    </video>
  );
}
```

```astro
---
// Astro
import { videoAspectRatio, videoSources, type VideoValue } from "sanity-video-ladder/core";

const { video, quality = "720" } = Astro.props as { video: VideoValue; quality?: string };
const playback = video.playback ?? {};
---

<video
  poster={video.placeholder ?? undefined}
  autoplay={playback.autoplay ?? true}
  muted={playback.muted ?? true}
  loop={playback.loop ?? true}
  controls={playback.controls ?? false}
  playsinline
  style={{ aspectRatio: videoAspectRatio(video), width: "100%" }}
>
  {videoSources(video.renditions, quality).map((source) => <source src={source.src} media={source.media} />)}
</video>
```

For any other logic, skip `videoSources`: pass it an array of `{ media, quality }` you built
yourself, or call `pickRendition(renditions, "720")` and write the markup however you like.

### Regenerating renditions

The CLI adds missing rungs to existing videos, re-encodes them, or drops rungs that are larger than
the file above them, using ffmpeg instead of the browser. It needs `ffmpeg` and `ffprobe` on the
`PATH` and a config file at the root of your project. Read your environment inside it; the package
never guesses variable names.

```ts
// video-ladder.config.ts
import { r2Storage, type VideoLadderCliConfig } from "sanity-video-ladder/storage";

export default {
  sanity: {
    projectId: process.env.SANITY_PROJECT_ID!,
    dataset: process.env.SANITY_DATASET!,
    apiVersion: "2026-01-01",
    token: process.env.SANITY_WRITE_TOKEN!, // needs write access
  },
  storage: r2Storage({ /* the same config as the endpoint */ }),
  typeName: "video", // as given to videoLadder()
  tiers: [240, 720], // as given to videoLadder()
} satisfies VideoLadderCliConfig;
```

```sh
npx sanity-video-ladder renditions --dry-run     # print the plan
npx sanity-video-ladder renditions               # add missing rungs, after one confirmation
npx sanity-video-ladder renditions --tiers 720 --filter reel --yes
npx sanity-video-ladder renditions --force       # re-encode every rung under new keys
npx sanity-video-ladder renditions --prune       # drop rungs not smaller than the next larger file
```

With a `.env` file, run it through your env loader, for example
`dotenvx run -- sanity-video-ladder renditions`. The config may also be `.mts`, `.mjs` or `.js`,
or anywhere with `--config <path>`.

## Storage

Any bucket that speaks the S3 API works. `r2Storage` fills in R2's endpoint and region; for anything
else, pass the full config:

```ts
import type { StorageConfig } from "sanity-video-ladder/storage";

const storage: StorageConfig = {
  endpoint: "https://s3.eu-west-1.amazonaws.com",
  region: "eu-west-1",
  bucket: "my-videos",
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  publicBaseUrl: "https://videos.example.com",
  keyPrefix: "videos/",
};
```

| Provider             | `endpoint`                                     | `region`            | `forcePathStyle` |
| -------------------- | ---------------------------------------------- | ------------------- | ---------------- |
| Cloudflare R2        | use `r2Storage({ accountId, ... })`            | `auto`              | no               |
| Amazon S3            | `https://s3.<region>.amazonaws.com`            | the bucket's region | no               |
| MinIO                | your server, e.g. `http://localhost:9000`      | `us-east-1`         | yes              |
| Backblaze B2         | `https://s3.<region>.backblazeb2.com`          | e.g. `us-west-004`  | no               |
| Tigris               | `https://t3.storage.dev`                       | `auto`              | no               |
| DigitalOcean Spaces  | `https://<region>.digitaloceanspaces.com`      | e.g. `nyc3`         | no               |

R2 is the provider this package is run against day to day. The others take the same S3 calls
(presigned `PUT` and `GET`, `ListObjectsV2`, `DeleteObjects`), but check your provider's own docs for
its endpoint and region.

**Public reads.** The site reads videos from `publicBaseUrl`, so the bucket must serve its objects
publicly there: a custom domain on R2, a CloudFront distribution or public bucket policy on S3, and
so on. `publicBaseUrl` may carry a path (`https://cdn.example.com/media`).

**CORS.** The browser uploads straight to the bucket, so its CORS policy must allow `PUT` from the
Studio's origin with the `content-type` and `cache-control` headers. Both headers are signed into
every upload URL; without `cache-control` in the policy, every upload fails its preflight. Add `GET`
for the origins that read videos with `crossorigin` (a WebGL texture, a canvas), and for the Studio
if you want the library's previews to load cross-origin.

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://www.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "cache-control"],
    "MaxAgeSeconds": 3600
  },
  {
    "AllowedOrigins": ["https://www.example.com"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

## API

### `sanity-video-ladder/studio`

#### `videoLadder(options)`

The Studio plugin. Registers the video object type with its upload input and, unless `library` is
`false`, the "Videos" tool.

| Option        | Type                | Default      | What it does                                                                                       |
| ------------- | ------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `apiVersion`  | `string`            | required     | The API version the input and the library query Sanity with.                                       |
| `endpoint`    | `string`            | `/api/video` | Where your `createVideoHandler` endpoint lives, on the Studio's origin.                            |
| `typeName`    | `string`            | `video`      | The name the object type is registered under.                                                      |
| `tiers`       | `number[]`          | `[240, 720]` | Every rung height a field may produce, and the ladder of a field without its own. Even numbers.    |
| `maxFileSize` | `number`            | 100 MB       | The largest file an editor may pick, in bytes.                                                     |
| `playback`    | `boolean`           | `true`       | Whether the type has a `playback` field (`autoplay`, `muted`, `loop`, `controls`).                 |
| `library`     | `boolean`           | `true`       | Whether to add the "Videos" tool.                                                                  |

A field narrows the ladder with `options: { tiers }` (type `VideoFieldOptions`), from the plugin's
`tiers`.

#### `VideoLibraryPicker`

The library as a dialog, for a custom input of your own: `onClose`, `onSelect(asset)`, and `busyId`
to show one asset as busy. It must render inside a Studio that has the plugin.

### `sanity-video-ladder/server`

#### `createVideoHandler(options)`

Returns `(request: Request) => Promise<Response>`, serving `POST` only.

| Option      | Type                             | Default  | What it does                                                                         |
| ----------- | -------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `authorize` | `(request) => Response \| null`  | required | Lets a request through with `null`, denies it with a `Response` returned unchanged. May be async. |
| `storage`   | `StorageConfig \| VideoStorage`  | required | A config (made into a storage on first request) or a storage from `createStorage`.   |
| `maxFiles`  | `number`                         | `16`     | The most files one upload may presign. An upload is the original, its poster and two files per rung. |

Every response has `cache-control: no-store` and the shape `{ ok: true, ... }` or
`{ ok: false, error }`. The body is `{ action, ... }`:

| Action     | Body                                       | Response                                          |
| ---------- | ------------------------------------------ | ------------------------------------------------- |
| `presign`  | `{ filename?, files: [{ name, contentType? }] }` | `{ folder, uploads: [{ name, key, uploadUrl, publicUrl }] }` |
| `list`     | none                                       | `{ assets }`, every video in the bucket           |
| `delete`   | `{ id }`, a folder key                     | `{ deleted }`, the number of objects removed      |
| `download` | `{ key }` or `{ url }`                     | `{ url }`, a five-minute presigned `GET` that saves the file |

### `sanity-video-ladder/storage`

| Export                      | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `r2Storage(config)`         | A `StorageConfig` for R2 from `accountId`, `bucket`, keys and `publicBaseUrl`.                   |
| `createStorage(config)`     | A `VideoStorage`: `presignUploads`, `presignDownload`, `listAssets`, `deleteAsset`, `deleteObjects`, `putObject`, `publicUrl`, `keyFromPublicUrl`, `folderFor`. The config is checked on first use. |
| `StorageConfig`             | `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey`, `publicBaseUrl`, and optional `forcePathStyle` and `keyPrefix` (default `videos/`). |
| `VideoLadderCliConfig`      | The shape `video-ladder.config.ts` exports.                                                      |

### `sanity-video-ladder/core`

Runs anywhere: no Studio, no React, no Node built-ins.

| Export                                    | What it does                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `videoSources(renditions, rules)`         | One `{ media?, src }` per rule. `rules` is a `sizes`-style string or an array of `{ media?, quality }`. |
| `pickRendition(renditions, quality?)`     | The smallest rendition at or above a tier, else the original. Without a tier, the original.  |
| `parseSourceRules(string)`                | The rules `videoSources` reads from a string, to inspect or extend.                          |
| `videoAspectRatio(video)`                 | Width over height of the source, or `undefined`.                                             |
| `hasRenditions(video)`                    | Whether the value has anything to play.                                                      |
| `selectShrinkingRenditions(renditions)`   | Splits `{ quality, bytes }` items into `kept` and `dropped`, keeping a rung only when it is smaller than the next larger kept file. |
| `normalizeTiers(tiers)`                   | Validates a ladder (positive even heights) and returns it sorted and deduplicated.           |
| `DEFAULT_TIERS`                           | `[240, 720]`.                                                                                |
| `VIDEO_PROJECTION`                        | The GROQ projection of every field a site needs.                                             |
| `VIDEO_CACHE_CONTROL`                     | The cache header every object is written with.                                               |

Types: `VideoValue`, `Rendition`, `Quality`, `Playback`, `SourceRule`, `VideoSource`.
`pickRendition` and `videoSources` read qualities through `stegaClean`, so they pick the right file
in draft mode too.

### The stored value

```ts
{
  _type: "video",
  renditions: [
    { _key: "original", _type: "rendition", quality: "original", url: ".../original.mov", poster: ".../poster.webp" },
    { _key: "mp4-720", _type: "rendition", quality: "720", url: ".../720p-3b91c0de.mp4", poster: ".../720p-3b91c0de-poster.webp" },
  ],
  placeholder: "data:image/webp;base64,...",
  dimensions: { width: 3840, height: 2160 },
  playback: { autoplay: true, muted: true, loop: true, controls: false },
}
```

There is no top-level URL: the untouched original is a rendition like any other.

## How it works

**Probe.** Picking a file dry-runs the real pipeline on a 0.3 second slice: the same MediaBunny
decode and encode the upload will use. WebCodecs' own `canDecode()` passes files that still fail once
a full conversion runs, so only this catches them up front. A file the browser cannot decode is
rejected with a re-export hint before anything is uploaded.

**Poster and placeholder.** One decoded frame, at a time the editor scrubs to, gives everything: a
WebP poster for the original (capped at 1920x1080), a downscaled poster per rung, and a 24 pixel WebP
blur stored as a base64 `placeholder` for the site to paint while the video loads. The stored
`dimensions` are the source's display size, so the aspect ratio is exact.

**The ladder.** Each checked rung is transcoded to H.264 MP4 at constant quality (quantizer 20, the
equivalent of ffmpeg's CRF 20), with a bitrate fallback for browsers whose encoder cannot do
quantizer mode. Audio is kept: copied when it is AAC, otherwise transcoded to AAC. A rung is never
taller than the source.

**Why the default stops at 720.** A 1080p rung of a screen recording measured a median 74% of the
original it was downscaled from, and on some clips within a few percent: the source was already
encoded efficiently, and a constant-quality encode spends what the detail needs. 720p drops four
times the pixels and halved the size. Larger slots are better served the original. Your sources may
differ, which is why the tiers are yours.

**Sizes must shrink.** After transcoding, a rung is kept only when it is smaller than the next
larger file kept. A rung that comes out larger would cost more bytes for fewer pixels, so it is
dropped and the larger file serves that tier. The CLI applies the same rule, and `--prune` applies it
to what is already in the bucket.

**Key layout.** Every upload gets a fresh folder, `<prefix><slug>-<timestamp>-<random>/`, holding
`original.<ext>`, `poster.webp`, and per rung `<n>p-<revision>.mp4` and `<n>p-<revision>-poster.webp`.
The library rebuilds every video from these names alone; everywhere else, the quality comes from the
stored value.

**Immutable caching.** No key is ever written twice with different content: the original and its
poster once per folder, every rung under a random revision. So every object is written with
`Cache-Control: public, max-age=31536000, immutable`, signed into the upload URL, and a re-encode is
a new URL that needs no cache purge.

**Where a video is used.** Videos are plain URLs, not Sanity assets, so the library scans every
document (drafts included) for the video's folder key. That count marks videos as Unused, and a video
still used anywhere cannot be deleted from the library.

## Caveats

- The editor's browser must encode H.264 with WebCodecs and decode the source: current Chrome, Edge,
  Firefox and Safari do, for H.264 8-bit 4:2:0 up to Level 5.1. HEVC, 10-bit and very high levels
  often do not decode; the probe says so and asks for a re-export.
- The tab must stay open while a video processes. Closing it produces nothing; picking the file again
  starts over.
- Files are limited to 100 MB by default (`maxFileSize`), since the whole file is processed in memory.
- The Studio must use `auth.loginMethod: "token"`, so the input can send the editor's token to your
  endpoint. Without it the input says so and stays disabled.
- `authorize` is required, so an endpoint can never ship open.
- The Studio and the endpoint must share an origin, which is the case for an embedded Studio. A Studio
  hosted elsewhere (on `*.sanity.studio`) would need CORS on the endpoint, which this version does not
  handle.
- A linked video (picked from the library) has no blur placeholder, since one is only made at upload.
- `<source media>` on a video is honoured by current browsers. One that ignores it takes the first
  source, which is the widest condition's.
- The Studio encodes with MediaBunny and the CLI with ffmpeg. They share the tiers, the naming and the
  shrinking rule, but they are different encoders aiming at the same quality.

## Development

```sh
npm install          # also installs the git hooks
npm run check        # types and lint
npm run format       # Biome, with fixes
npm test             # node:test, run on the TypeScript sources
npm run build        # dist/, from tsc
npm run release -- patch|minor|major   # changelog, version, tag, push; CI publishes
```

The Studio is verified in a real Studio: build, `yalc publish`, and `yalc add sanity-video-ladder` in
a host project. Commits follow Conventional Commits and are checked by a hook. A release is one
command: it rolls the changelog's Unreleased section into a dated version, bumps, tags and pushes;
the tag then runs a workflow that publishes to npm through trusted publishing and lists the GitHub
release. Try it with `--dry-run` first. Instructions for agents live in `AGENTS.md` and
`.agents/skills/`.

A pull request follows the template in `.github/PULL_REQUEST_TEMPLATE.md`. A workflow checks the
description against the template, the title and the commits against Conventional Commits, and runs
the types, the lint and the tests; main requires all of them before a merge.

## License

MIT
