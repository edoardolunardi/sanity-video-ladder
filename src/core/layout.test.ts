import assert from "node:assert/strict";
import { test } from "node:test";
import { VIDEO_PROJECTION } from "./groq.ts";
import {
  friendlyName,
  friendlyNameFromUrl,
  newRevision,
  originalFileName,
  renditionKey,
  rungFileNames,
  VIDEO_CACHE_CONTROL,
} from "./layout.ts";

test("names stay what existing objects and documents were written with", () => {
  assert.equal(VIDEO_CACHE_CONTROL, "public, max-age=31536000, immutable");
  assert.deepEqual(rungFileNames(720, "3b91c0de"), { video: "720p-3b91c0de.mp4", poster: "720p-3b91c0de-poster.webp" });
  assert.equal(originalFileName("MOV"), "original.mov");
  assert.equal(originalFileName(".mp4"), "original.mp4");
  assert.equal(originalFileName(""), "original.mp4");
  assert.equal(renditionKey("original"), "original");
  assert.equal(renditionKey("720"), "mp4-720");
});

test("newRevision is eight hex characters and differs between calls", () => {
  const revisions = new Set(Array.from({ length: 50 }, () => newRevision()));

  for (const revision of revisions) {
    assert.match(revision, /^[0-9a-f]{8}$/);
  }

  assert.ok(revisions.size > 45);
});

test("friendlyName strips the timestamp and random suffix from the folder", () => {
  assert.equal(friendlyName("videos/glyph-field-0-1755000000000-k3j9x2ab"), "glyph field 0");
  assert.equal(friendlyName("media/clips/my_reel-1755000000000-abc"), "my reel");
  assert.equal(friendlyName("glyph-1755000000000-k3j9x2ab/"), "glyph");
  // A folder without the suffix keeps its whole name.
  assert.equal(friendlyName("videos/legacy-clip"), "legacy clip");
  assert.equal(friendlyName("videos/1755000000000-abc"), "1755000000000 abc");
});

test("friendlyNameFromUrl reads the folder from a file URL, whatever the prefix or base path", () => {
  assert.equal(friendlyNameFromUrl("https://media.example.com/videos/glyph-1755000000000-k3j9x2ab/original.mp4"), "glyph");
  assert.equal(friendlyNameFromUrl("https://cdn.example.com/site/clips/reel-1755000000000-abc/720p-1.mp4?v=1"), "reel");
  assert.equal(friendlyNameFromUrl("https://cdn.example.com/original.mp4"), "");
  assert.equal(friendlyNameFromUrl("https://cdn.example.com/my%20clip-1755000000000-abc/original.mp4"), "my clip");
  assert.equal(friendlyNameFromUrl("https://cdn.example.com/bad%E0-1755000000000-abc/original.mp4"), "bad%E0");
  assert.equal(friendlyNameFromUrl("not a url"), "");
  assert.equal(friendlyNameFromUrl(""), "");
});

test("VIDEO_PROJECTION selects every field of the stored value", () => {
  for (const field of ["renditions[]{ quality, url, poster }", "placeholder", "dimensions{ width, height }"]) {
    assert.ok(VIDEO_PROJECTION.includes(field), field);
  }
  assert.ok(VIDEO_PROJECTION.includes("playback{ autoplay, muted, loop, controls }"));
});
