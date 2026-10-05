import assert from "node:assert/strict";
import { test } from "node:test";
import { r2Storage, resolveStorageConfig } from "./config.ts";
import {
  buildFolder,
  downloadFilename,
  isInsidePrefix,
  keyFromPublicUrl,
  normalizeKeyPrefix,
  publicUrlFor,
  safeName,
  slugifyFilename,
} from "./keys.ts";

test("normalizeKeyPrefix leaves exactly one trailing slash, and defaults to videos/", () => {
  assert.equal(normalizeKeyPrefix(undefined), "videos/");
  assert.equal(normalizeKeyPrefix(""), "videos/");
  assert.equal(normalizeKeyPrefix("  /  "), "videos/");
  assert.equal(normalizeKeyPrefix("clips"), "clips/");
  assert.equal(normalizeKeyPrefix("/site/clips//"), "site/clips/");
});

test("buildFolder slugs the file name under the prefix with a timestamp and a random suffix", () => {
  assert.equal(
    buildFolder("videos/", "My Reel (final).MOV", 1755000000000, "k3j9x2ab"),
    "videos/my-reel-final-1755000000000-k3j9x2ab"
  );
  assert.equal(buildFolder("videos/", "...mp4", 1, "a"), "videos/video-1-a");
  assert.match(buildFolder("videos/", "clip.mp4"), /^videos\/clip-\d{13}-[a-z0-9]{8}$/);
  assert.notEqual(buildFolder("videos/", "clip.mp4"), buildFolder("videos/", "clip.mp4"));
});

test("slugifyFilename and safeName keep keys to safe characters", () => {
  assert.equal(slugifyFilename("Über Clip.mp4"), "ber-clip");
  assert.equal(slugifyFilename(""), "video");
  assert.equal(safeName("720p-3b91c0de.mp4"), "720p-3b91c0de.mp4");
  assert.equal(safeName("../../etc/passwd"), "etc-passwd");
  assert.equal(safeName("a b/c.mp4"), "a-b-c.mp4");
  assert.equal(safeName("..."), "file");
});

test("isInsidePrefix refuses the prefix itself, other prefixes and parent references", () => {
  assert.equal(isInsidePrefix("videos/a-1-b/720p.mp4", "videos/"), true);
  assert.equal(isInsidePrefix("videos/", "videos/"), false);
  assert.equal(isInsidePrefix("other/a/720p.mp4", "videos/"), false);
  assert.equal(isInsidePrefix("videos/../secret", "videos/"), false);
});

test("keyFromPublicUrl strips the base as a prefix, with or without a path segment", () => {
  assert.equal(keyFromPublicUrl("https://media.example.com", "https://media.example.com/videos/a/720p.mp4"), "videos/a/720p.mp4");
  assert.equal(
    keyFromPublicUrl("https://media.example.com/", "https://media.example.com/videos/a/720p.mp4?v=2#t"),
    "videos/a/720p.mp4"
  );
  assert.equal(
    keyFromPublicUrl("https://cdn.example.com/site", "https://cdn.example.com/site/videos/a/720p.mp4"),
    "videos/a/720p.mp4"
  );
  assert.equal(keyFromPublicUrl("https://cdn.example.com/site", "https://cdn.example.com/other/videos/a.mp4"), null);
  assert.equal(keyFromPublicUrl("https://cdn.example.com/site", "https://cdn.example.com/sitemap/a.mp4"), null);
  assert.equal(keyFromPublicUrl("https://media.example.com", "https://media.example.com/"), null);
  assert.equal(
    publicUrlFor("https://cdn.example.com/site/", "videos/a/720p.mp4"),
    "https://cdn.example.com/site/videos/a/720p.mp4"
  );
});

test("downloadFilename names a file after its video", () => {
  assert.equal(downloadFilename("videos/amadee-7-1755000000000-k3j9x2ab/720p-3b91c0de.mp4"), "amadee-7-720p-3b91c0de.mp4");
});

test("r2Storage fills in R2's endpoint and region", () => {
  const config = r2Storage({
    accountId: "abc123",
    bucket: "media",
    accessKeyId: "id",
    secretAccessKey: "secret",
    publicBaseUrl: "https://media.example.com",
    keyPrefix: "clips",
  });
  assert.equal(config.endpoint, "https://abc123.r2.cloudflarestorage.com");
  assert.equal(config.region, "auto");
  assert.equal(config.keyPrefix, "clips");
  assert.equal("accountId" in config, false);
});

test("resolveStorageConfig names every missing field, never an environment variable", () => {
  assert.throws(
    () =>
      resolveStorageConfig(
        r2Storage({ accountId: "", bucket: " ", accessKeyId: "id", secretAccessKey: "", publicBaseUrl: "https://m" })
      ),
    /missing endpoint \(accountId with r2Storage\), bucket, secretAccessKey\.$/
  );
  const resolved = resolveStorageConfig({
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "b",
    accessKeyId: "i",
    secretAccessKey: "s",
    publicBaseUrl: "http://localhost:9000/b/",
  });
  assert.equal(resolved.publicBaseUrl, "http://localhost:9000/b");
  assert.equal(resolved.keyPrefix, "videos/");
  assert.equal(resolved.forcePathStyle, false);
});
