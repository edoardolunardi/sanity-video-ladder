import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findConfigPath, validateCliConfig } from "./config.ts";
import {
  audioPlanFor,
  buildPosterArgs,
  buildRendition,
  buildTranscodeArgs,
  collectVideoOccurrences,
  folderFromUrl,
  parseTiers,
  planFolders,
  rungMaxrate,
  tiersToEncode,
} from "./plan.ts";

const BASE = "https://media.example.com";

function video(folder: string, qualities: string[], height?: number, width?: number, type = "video") {
  return {
    _type: type,
    dimensions: height ? { width: width ?? Math.round((height * 16) / 9), height } : undefined,
    renditions: qualities.map((quality) => ({
      _key: `k-${quality}`,
      quality,
      url: `${BASE}/videos/${folder}/${quality === "original" ? "original.mp4" : `${quality}p.mp4`}`,
      poster: `${BASE}/videos/${folder}/${quality === "original" ? "poster.webp" : `${quality}p-poster.webp`}`,
    })),
  };
}

test("folderFromUrl returns the folder key only under the public base, with or without a path", () => {
  assert.equal(folderFromUrl(`${BASE}/videos/prism-1/original.mp4`, BASE), "videos/prism-1");
  assert.equal(folderFromUrl(`${BASE}/videos/prism-1/original.mp4?x=1`, `${BASE}/`), "videos/prism-1");
  assert.equal(folderFromUrl("https://elsewhere.com/videos/a/original.mp4", BASE), null);
  assert.equal(folderFromUrl(`${BASE}/original.mp4`, BASE), null);
  assert.equal(folderFromUrl("https://cdn.example.com/site/videos/a/original.mp4", "https://cdn.example.com/site"), "videos/a");
});

test("collectVideoOccurrences walks arrays and rich text with patchable paths and rendition keys", () => {
  const documents = [
    {
      _id: "work-1",
      _type: "work",
      media: [
        { _key: "m1", ...video("a", ["original", "720", "240"], 2160, 3840) },
        { _key: "img", _type: "image" },
      ],
      // A field of an object type stores the value without a `_type`.
      description: [
        { _key: "b1", _type: "media", type: "video", video: { ...video("b", ["original", "240"], 1080), _type: undefined } },
      ],
    },
    {
      _id: "other",
      _type: "about",
      media: [{ _key: "x", _type: "video", renditions: [{ _key: "o", url: "https://elsewhere.com/v/original.mp4" }] }],
    },
  ];

  const found = collectVideoOccurrences(documents, BASE);

  assert.deepEqual(
    found.map((occurrence) => [
      occurrence.documentId,
      occurrence.path,
      occurrence.folder,
      occurrence.height,
      occurrence.renditions.map((rendition) => `${rendition.key}:${rendition.quality}`),
    ]),
    [
      ["work-1", 'media[_key=="m1"]', "videos/a", 2160, ["k-original:original", "k-720:720", "k-240:240"]],
      ["work-1", 'description[_key=="b1"].video', "videos/b", 1080, ["k-original:original", "k-240:240"]],
    ]
  );
});

test("collectVideoOccurrences only takes objects of the configured type name", () => {
  const documents = [
    {
      _id: "p",
      _type: "project",
      media: [
        { _key: "a", ...video("a", ["original"], 1080, undefined, "appVideo") },
        { _key: "b", ...video("b", ["original"], 1080, undefined, "video") },
      ],
    },
  ];

  assert.deepEqual(
    collectVideoOccurrences(documents, BASE, "appVideo").map((occurrence) => occurrence.folder),
    ["videos/a"]
  );
});

test("planFolders groups by folder and decides per tier from the source height", () => {
  const documents = [
    {
      _id: "w",
      _type: "work",
      media: [
        { _key: "a", ...video("a", ["original"], 2160, 3840) },
        // No taller than the 720 rung, so that tier would re-encode the original at its own size.
        { _key: "b", ...video("b", ["original", "720", "240"], 720) },
        { _key: "d", ...video("d", ["original"]) },
      ],
    },
    { _id: "e", _type: "experiment", media: [{ _key: "a", ...video("a", ["original", "720"], 2160, 3840) }] },
  ];

  const plans = planFolders(collectVideoOccurrences(documents, BASE), [240, 720]);
  const byFolder = Object.fromEntries(plans.map((plan) => [plan.folder, plan]));
  const statuses = (folder: string) => byFolder[folder]?.tiers.map((tier) => `${tier.tier}:${tier.status}`);

  // One document has the 720 rung and the other does not.
  assert.deepEqual(statuses("videos/a"), ["240:generate", "720:generate"]);
  assert.deepEqual(
    byFolder["videos/a"]?.tiers[1]?.missing.map((occurrence) => occurrence.documentId),
    ["w"]
  );
  assert.deepEqual(
    byFolder["videos/a"]?.tiers[1]?.present.map((occurrence) => occurrence.documentId),
    ["e"]
  );
  assert.equal(byFolder["videos/a"]?.width, 3840);
  assert.deepEqual(statuses("videos/b"), ["240:has-tier", "720:too-small"]);
  assert.deepEqual(statuses("videos/d"), ["240:generate", "720:generate"]);
});

test("planFolders follows the configured tiers", () => {
  const documents = [{ _id: "w", _type: "work", media: [{ _key: "a", ...video("a", ["original", "720"], 2160, 3840) }] }];
  const [plan] = planFolders(collectVideoOccurrences(documents, BASE), [480, 720, 1080]);

  assert.deepEqual(
    plan?.tiers.map((tier) => `${tier.tier}:${tier.status}`),
    ["480:generate", "720:has-tier", "1080:generate"]
  );
});

test("tiersToEncode includes existing tiers only when forced", () => {
  const plan = planFolders(
    collectVideoOccurrences(
      [{ _id: "w", _type: "work", media: [{ _key: "a", ...video("a", ["original", "720"], 2160) }] }],
      BASE
    ),
    [240, 720]
  )[0];

  assert.ok(plan);
  assert.deepEqual(
    tiersToEncode(plan, false).map((tier) => tier.tier),
    [240]
  );
  assert.deepEqual(
    tiersToEncode(plan, true).map((tier) => tier.tier),
    [240, 720]
  );
});

test("rungMaxrate caps peaks at 4 bits per pixel-second of the rung", () => {
  assert.equal(rungMaxrate(720, 3840, 2160), 3_686_400);
  assert.equal(rungMaxrate(240, 1920, 1080), 409_920);
});

test("parseTiers accepts the configured tiers and rejects the rest", () => {
  assert.deepEqual(parseTiers(undefined, [240, 720]), [240, 720]);
  assert.deepEqual(parseTiers("720, 240", [240, 720]), [240, 720]);
  assert.deepEqual(parseTiers("1080", [240, 720, 1080]), [1080]);
  assert.throws(() => parseTiers("900", [240, 720]), /Unknown tier "900"\. Use 240, 720/);
  assert.throws(() => parseTiers("1080", [240, 720]), /Unknown tier/);
});

test("audioPlanFor copies AAC, re-encodes anything else, keeps silence silent", () => {
  assert.equal(audioPlanFor("aac"), "copy");
  assert.equal(audioPlanFor("opus"), "aac");
  assert.equal(audioPlanFor(undefined), "none");
});

test("buildTranscodeArgs encodes at constant quality with a peak cap and the audio plan", () => {
  const args = buildTranscodeArgs({ input: "in.mp4", output: "out.mp4", height: 720, maxrate: 2_000_000, audio: "copy" });
  const line = args.join(" ");

  assert.ok(args.includes("scale=-2:720"));
  assert.ok(line.includes("-c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p -crf 20"));
  assert.ok(line.includes("-c:a copy"));
  assert.ok(!args.includes("-b:v"));
  assert.ok(line.includes("-maxrate 2000000 -bufsize 4000000"));
  assert.ok(line.includes("-movflags +faststart"));
  assert.equal(args.at(-1), "out.mp4");

  assert.ok(buildTranscodeArgs({ input: "i", output: "o", height: 720, maxrate: 1, audio: "none" }).includes("-an"));
  assert.ok(
    buildTranscodeArgs({ input: "i", output: "o", height: 720, maxrate: 1, audio: "aac" })
      .join(" ")
      .includes("-c:a aac -b:a 128k")
  );
});

test("buildPosterArgs never upscales and seeks only when reading the video", () => {
  const fromPoster = buildPosterArgs({ input: "poster.webp", output: "720p-poster.webp", height: 720, fromVideo: false });
  const fromVideo = buildPosterArgs({ input: "in.mp4", output: "720p-poster.webp", height: 720, fromVideo: true });

  assert.ok(fromPoster.includes("scale=-2:'min(720,ih)'"));
  assert.ok(fromPoster.join(" ").includes("-c:v libwebp -quality 80"));
  assert.ok(!fromPoster.includes("-ss"));
  assert.ok(fromVideo.join(" ").includes("-ss 0.1"));
});

test("buildRendition writes the stored shape", () => {
  assert.deepEqual(buildRendition({ key: "abc", tier: 720, url: "u", poster: "p" }), {
    _key: "abc",
    _type: "rendition",
    quality: "720",
    url: "u",
    poster: "p",
  });
});

test("validateCliConfig names what is missing and fills the defaults", () => {
  assert.throws(
    () => validateCliConfig({ sanity: { projectId: "p", dataset: "" } }, "c.ts"),
    /c\.ts is missing sanity\.dataset, sanity\.apiVersion, sanity\.token, storage\./
  );
  assert.throws(() => validateCliConfig(undefined, "c.ts"), /missing sanity\.projectId/);

  const config = validateCliConfig(
    {
      sanity: { projectId: "p", dataset: "d", apiVersion: "2026-01-01", token: "t" },
      storage: { bucket: "b" },
      tiers: [720, 240, 720],
    },
    "c.ts"
  );
  assert.equal(config.typeName, "video");
  assert.deepEqual(config.tiers, [240, 720]);
  assert.throws(() => validateCliConfig({ ...config, tiers: [721] }, "c.ts"), /Invalid tier 721/);
});

test("findConfigPath prefers --config, then the first config file in the folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svl-config-"));

  assert.throws(() => findConfigPath(undefined, dir), /No config file found\. Add video-ladder\.config\.ts/);
  await writeFile(join(dir, "video-ladder.config.mjs"), "export default {};");
  assert.equal(findConfigPath(undefined, dir), join(dir, "video-ladder.config.mjs"));
  await writeFile(join(dir, "video-ladder.config.ts"), "export default {};");
  assert.equal(findConfigPath(undefined, dir), join(dir, "video-ladder.config.ts"));
  assert.equal(findConfigPath("video-ladder.config.mjs", dir), join(dir, "video-ladder.config.mjs"));
  assert.throws(() => findConfigPath("nope.ts", dir), /No config file at/);
});
