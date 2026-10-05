import assert from "node:assert/strict";
import { test } from "node:test";
import { parseListing } from "./list.ts";

const url = (key: string) => `https://m/${key}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

test("parseListing rebuilds a revisioned video with each rendition's own poster", () => {
  const folder = "videos/reel-1755000000000-k3j9x2ab";
  const [asset] = parseListing(
    [
      { Key: `${folder}/original.MOV`, Size: 9_000, LastModified: at(1) },
      { Key: `${folder}/poster.webp`, Size: 40, LastModified: at(1) },
      { Key: `${folder}/720p-3b91c0de.mp4`, Size: 3_000, LastModified: at(2) },
      { Key: `${folder}/720p-3b91c0de-poster.webp`, Size: 20, LastModified: at(2) },
      { Key: `${folder}/240p-77a0e1f2.mp4`, Size: 700, LastModified: at(1) },
      { Key: `${folder}/240p-77a0e1f2-poster.webp`, Size: 4, LastModified: at(1) },
    ],
    url
  );

  assert.deepEqual(asset, {
    id: folder,
    name: "reel",
    poster: url(`${folder}/poster.webp`),
    renditions: [
      {
        quality: "240",
        url: url(`${folder}/240p-77a0e1f2.mp4`),
        container: "mp4",
        bytes: 700,
        poster: url(`${folder}/240p-77a0e1f2-poster.webp`),
      },
      {
        quality: "720",
        url: url(`${folder}/720p-3b91c0de.mp4`),
        container: "mp4",
        bytes: 3_000,
        poster: url(`${folder}/720p-3b91c0de-poster.webp`),
      },
      {
        quality: "original",
        url: url(`${folder}/original.MOV`),
        container: "mov",
        bytes: 9_000,
        poster: url(`${folder}/poster.webp`),
      },
    ],
    bytes: 12_764,
    updatedAt: at(2).toISOString(),
  });
});

test("parseListing reads the names written before revisions", () => {
  const [asset] = parseListing(
    [
      { Key: "videos/old/original.mp4", Size: 10 },
      { Key: "videos/old/720p.mp4", Size: 5 },
      { Key: "videos/old/720p-poster.webp", Size: 1 },
      { Key: "videos/old/240p.webm", Size: 2 },
    ],
    url
  );

  assert.deepEqual(
    asset?.renditions.map((r) => [r.quality, r.container, r.poster ?? null]),
    [
      ["240", "webm", null],
      ["720", "mp4", url("videos/old/720p-poster.webp")],
      ["original", "mp4", null],
    ]
  );
  assert.equal(asset?.poster, null);
  assert.equal(asset?.updatedAt, null);
});

test("parseListing keeps the newest of two revisions of one tier, with that revision's poster", () => {
  const listed = [
    { Key: "videos/v/original.mp4", Size: 100, LastModified: at(0) },
    { Key: "videos/v/720p-bbbbbbbb.mp4", Size: 30, LastModified: at(9) },
    { Key: "videos/v/720p-bbbbbbbb-poster.webp", Size: 1, LastModified: at(9) },
    { Key: "videos/v/720p-aaaaaaaa.mp4", Size: 50, LastModified: at(3) },
    { Key: "videos/v/720p-aaaaaaaa-poster.webp", Size: 2, LastModified: at(3) },
  ];

  for (const objects of [listed, [...listed].reverse()]) {
    const [asset] = parseListing(objects, url);
    const rung = asset?.renditions.find((r) => r.quality === "720");
    assert.equal(rung?.url, url("videos/v/720p-bbbbbbbb.mp4"));
    assert.equal(rung?.poster, url("videos/v/720p-bbbbbbbb-poster.webp"));
    assert.equal(asset?.renditions.length, 2);
    // The folder's size still counts the stale revision: deleting the video deletes it too.
    assert.equal(asset?.bytes, 183);
  }
});

test("parseListing ignores stray files and leaves out folders with nothing to play", () => {
  const assets = parseListing(
    [
      { Key: "videos/a/original.mp4", Size: 1, LastModified: at(1) },
      { Key: "videos/a/notes.txt", Size: 1, LastModified: at(5) },
      { Key: "videos/a/720p.mov", Size: 1 },
      { Key: "videos/a/thumb.webp", Size: 1 },
      { Key: "videos/only-poster/poster.webp", Size: 1 },
      { Key: "root-file.mp4", Size: 1 },
      {},
    ],
    url
  );

  assert.deepEqual(
    assets.map((asset) => [asset.id, asset.renditions.map((r) => r.quality)]),
    [["videos/a", ["original"]]]
  );
});

test("parseListing sorts videos newest first", () => {
  const assets = parseListing(
    [
      { Key: "videos/old/original.mp4", LastModified: at(1) },
      { Key: "videos/new/original.mp4", LastModified: at(7) },
      { Key: "videos/undated/original.mp4" },
      { Key: "videos/mid/original.mp4", LastModified: at(4) },
    ],
    url
  );

  assert.deepEqual(
    assets.map((asset) => asset.id),
    ["videos/new", "videos/mid", "videos/old", "videos/undated"]
  );
});
