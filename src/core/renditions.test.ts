import assert from "node:assert/strict";
import { test } from "node:test";
import { ladder, stega } from "../fixtures.ts";
import {
  DEFAULT_TIERS,
  hasRenditions,
  normalizeTiers,
  pickRendition,
  selectShrinkingRenditions,
  videoAspectRatio,
} from "./renditions.ts";
import type { Quality } from "./types.ts";

test("pickRendition takes the smallest tier at or above the request, else the original", () => {
  const { renditions } = ladder([240, 720]);
  assert.equal(pickRendition(renditions, "720")?.url, "https://m/v/720p-abc.mp4");
  assert.equal(pickRendition(renditions, "240")?.url, "https://m/v/240p-abc.mp4");
  assert.equal(pickRendition(renditions, "480")?.url, "https://m/v/720p-abc.mp4");
  assert.equal(pickRendition(renditions, "original")?.url, "https://m/v/original.mp4");
  assert.equal(pickRendition(renditions)?.url, "https://m/v/original.mp4");

  // No tier is large enough: the original serves it.
  assert.equal(pickRendition(ladder([240]).renditions, "720")?.url, "https://m/v/original.mp4");
});

test("pickRendition skips renditions without a URL and returns nothing when none plays", () => {
  assert.equal(
    pickRendition([{ quality: "720" }, { quality: "original", url: "https://m/o.mp4" }], "720")?.url,
    "https://m/o.mp4"
  );
  assert.equal(pickRendition([], "720"), undefined);
  assert.equal(pickRendition(null), undefined);
  assert.equal(pickRendition(undefined, "240"), undefined);
});

test("pickRendition falls back to the largest rung when there is no original", () => {
  const renditions = [
    { quality: "240" as const, url: "https://m/240.mp4" },
    { quality: "720" as const, url: "https://m/720.mp4" },
  ];
  assert.equal(pickRendition(renditions, "1080")?.url, "https://m/720.mp4");
  assert.equal(pickRendition(renditions, "original")?.url, "https://m/720.mp4");
});

test("pickRendition reads stega-encoded qualities as the tier they carry", () => {
  // Draft mode encodes every string a query returns. Without stegaClean, Number() of "720" plus the marks
  // is NaN and `=== "original"` is false, so the 720p request would silently get the original.
  const renditions = [
    { quality: stega("original") as Quality, url: "https://m/original.mp4" },
    { quality: stega("240") as Quality, url: "https://m/240.mp4" },
    { quality: stega("720") as Quality, url: "https://m/720.mp4" },
  ];
  assert.equal(pickRendition(renditions, "720")?.url, "https://m/720.mp4");
  assert.equal(pickRendition(renditions, "240")?.url, "https://m/240.mp4");
  assert.equal(pickRendition(renditions, stega("720") as Quality)?.url, "https://m/720.mp4");
  assert.equal(pickRendition(renditions, "original")?.url, "https://m/original.mp4");
});

test("hasRenditions is true only with a playable rendition", () => {
  assert.equal(hasRenditions(ladder([])), true);
  assert.equal(hasRenditions({ renditions: [{ quality: "original" }] }), false);
  assert.equal(hasRenditions({ renditions: null }), false);
  assert.equal(hasRenditions(null), false);
  assert.equal(hasRenditions(undefined), false);
});

test("videoAspectRatio divides the source size, and needs both sides", () => {
  assert.equal(videoAspectRatio(ladder([], { width: 1920, height: 1080 })), 1920 / 1080);
  assert.equal(videoAspectRatio({ dimensions: { width: 1920, height: null } }), undefined);
  assert.equal(videoAspectRatio({ dimensions: { width: 0, height: 1080 } }), undefined);
  assert.equal(videoAspectRatio({}), undefined);
  assert.equal(videoAspectRatio(null), undefined);
});

test("selectShrinkingRenditions keeps only rungs smaller than the next larger kept file", () => {
  const result = selectShrinkingRenditions([
    { quality: "240", bytes: 700_000 },
    { quality: "720", bytes: 5_500_000 },
    { quality: "original", bytes: 4_200_000 },
  ]);

  assert.deepEqual(
    result.kept.map((r) => r.quality),
    ["original", "240"]
  );
  assert.deepEqual(
    result.dropped.map((d) => `${d.rendition.quality}>${d.largerThan.quality}`),
    ["720>original"]
  );

  // The ceiling follows the kept files: the 240p is measured against the 720p, not the original.
  const chain = selectShrinkingRenditions([
    { quality: "240", bytes: 3_000_000 },
    { quality: "720", bytes: 2_000_000 },
    { quality: "original", bytes: 9_000_000 },
  ]);
  assert.deepEqual(
    chain.kept.map((r) => r.quality),
    ["original", "720"]
  );
  assert.deepEqual(
    chain.dropped.map((d) => `${d.rendition.quality}>${d.largerThan.quality}`),
    ["240>720"]
  );

  // A rung exactly as large as the file above it is dropped too: it saves nothing.
  const equal = selectShrinkingRenditions([
    { quality: "720", bytes: 1_000 },
    { quality: "original", bytes: 1_000 },
  ]);
  assert.deepEqual(
    equal.kept.map((r) => r.quality),
    ["original"]
  );
});

test("normalizeTiers sorts, dedupes and accepts any positive even height", () => {
  assert.deepEqual(normalizeTiers([720, 240, 720]), [240, 720]);
  assert.deepEqual(normalizeTiers([2160, 480, 1080, 360]), [360, 480, 1080, 2160]);
  assert.deepEqual(normalizeTiers([]), []);
  assert.deepEqual(normalizeTiers(DEFAULT_TIERS), [240, 720]);
});

test("normalizeTiers rejects a height H.264 cannot encode or that is no height", () => {
  for (const tier of [0, -240, 241, 720.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeTiers([240, tier]), /Invalid tier/, String(tier));
  }
});
