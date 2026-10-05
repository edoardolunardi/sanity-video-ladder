import assert from "node:assert/strict";
import { test } from "node:test";
import { ladder, stega } from "../fixtures.ts";
import { parseSourceRules, videoSources } from "./sources.ts";
import type { Quality } from "./types.ts";

test("videoSources emits one source per media condition, in the order written", () => {
  const { renditions } = ladder([240, 720], { width: 2880, height: 1620 });

  assert.deepEqual(videoSources(renditions, "(min-width: 48rem) original, 720"), [
    { media: "(min-width: 48rem)", src: "https://m/v/original.mp4" },
    { src: "https://m/v/720p-abc.mp4" },
  ]);

  assert.deepEqual(videoSources(renditions, "(min-width: 64rem) original, (min-width: 48rem) 720, 240"), [
    { media: "(min-width: 64rem)", src: "https://m/v/original.mp4" },
    { media: "(min-width: 48rem)", src: "https://m/v/720p-abc.mp4" },
    { src: "https://m/v/240p-abc.mp4" },
  ]);
});

test("videoSources passes any media condition through untouched", () => {
  const { renditions } = ladder([240, 720]);

  assert.deepEqual(
    videoSources(renditions, "(orientation: portrait) and (min-height: 900px) original, (min-resolution: 2dppx) 720, 240"),
    [
      { media: "(orientation: portrait) and (min-height: 900px)", src: "https://m/v/original.mp4" },
      { media: "(min-resolution: 2dppx)", src: "https://m/v/720p-abc.mp4" },
      { src: "https://m/v/240p-abc.mp4" },
    ]
  );
  assert.deepEqual(videoSources(renditions, "  (min-width:  768px)   original ,720 "), [
    { media: "(min-width:  768px)", src: "https://m/v/original.mp4" },
    { src: "https://m/v/720p-abc.mp4" },
  ]);
});

test("videoSources collapses to one plain source when every condition resolves to the fallback", () => {
  // A clip with no rungs resolves every tier to the original.
  assert.deepEqual(videoSources(ladder([], { width: 640, height: 360 }).renditions, "(min-width: 48rem) original, 720"), [
    { src: "https://m/v/original.mp4" },
  ]);
  assert.deepEqual(videoSources(ladder([240, 720]).renditions, "720"), [{ src: "https://m/v/720p-abc.mp4" }]);

  // Only the trailing run that repeats the fallback goes; a source between two others stays.
  assert.deepEqual(videoSources(ladder([240, 720]).renditions, "(min-width: 64rem) 720, (min-width: 48rem) 240, 240"), [
    { media: "(min-width: 64rem)", src: "https://m/v/720p-abc.mp4" },
    { src: "https://m/v/240p-abc.mp4" },
  ]);
});

test("videoSources falls back to the original and ignores entries after the fallback, as sizes does", () => {
  const { renditions } = ladder([240, 720]);

  assert.deepEqual(videoSources(renditions, "(min-width: 48rem) 720"), [
    { media: "(min-width: 48rem)", src: "https://m/v/720p-abc.mp4" },
    { src: "https://m/v/original.mp4" },
  ]);
  assert.deepEqual(videoSources(renditions, "240, (min-width: 48rem) original"), [{ src: "https://m/v/240p-abc.mp4" }]);
  assert.deepEqual(videoSources(renditions, ""), [{ src: "https://m/v/original.mp4" }]);
  assert.deepEqual(videoSources([], "(min-width: 48rem) original, 720"), []);
  assert.deepEqual(videoSources(null, "720"), []);
});

test("videoSources takes rules already built, for a component with its own logic", () => {
  const { renditions } = ladder([240, 720]);

  assert.deepEqual(videoSources(renditions, [{ media: "(min-width: 900px)", quality: "original" }, { quality: "240" }]), [
    { media: "(min-width: 900px)", src: "https://m/v/original.mp4" },
    { src: "https://m/v/240p-abc.mp4" },
  ]);
  assert.deepEqual(videoSources(renditions, []), [{ src: "https://m/v/original.mp4" }]);
});

test("videoSources picks the right tier from stega-encoded renditions", () => {
  const renditions = [
    { quality: stega("original") as Quality, url: "https://m/original.mp4" },
    { quality: stega("720") as Quality, url: "https://m/720.mp4" },
  ];
  assert.deepEqual(videoSources(renditions, "(min-width: 48rem) original, 720"), [
    { media: "(min-width: 48rem)", src: "https://m/original.mp4" },
    { src: "https://m/720.mp4" },
  ]);
});

test("parseSourceRules reads each entry as an optional condition and a tier", () => {
  assert.deepEqual(parseSourceRules("(min-width: 48rem) and (max-width: calc(80rem - 1px)) original, 720"), [
    { media: "(min-width: 48rem) and (max-width: calc(80rem - 1px))", quality: "original" },
    { quality: "720" },
  ]);
  assert.deepEqual(parseSourceRules(" , 240 ,, "), [{ quality: "240" }]);
});

test("parseSourceRules throws on an entry that does not end in a tier", () => {
  assert.throws(() => parseSourceRules("hd"), /Invalid quality "hd" in "hd"/);
  assert.throws(() => parseSourceRules("(min-width: 48rem) 720p, 240"), /Invalid quality "720p"/);
  assert.throws(() => parseSourceRules("(min-width: 48rem), 240"), /Invalid quality "48rem\)"/);
});
