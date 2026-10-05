import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeleteObjectsCommand,
  type GetObjectCommand,
  ListObjectsV2Command,
  type PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { r2Storage, type StorageConfig } from "./config.ts";
import { createStorage } from "./storage.ts";

const config: StorageConfig = r2Storage({
  accountId: "acct",
  bucket: "media",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  publicBaseUrl: "https://media.example.com",
});

type Command = PutObjectCommand | GetObjectCommand | ListObjectsV2Command | DeleteObjectsCommand;

/** A real client, so presigning runs the real signer offline, with `send` recording commands and answering
 *  from a script instead of the network. */
function fakeClient(answer: (command: Command) => unknown = () => ({})) {
  const sent: Command[] = [];
  const client = new S3Client({
    region: "auto",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  client.send = (async (command: Command) => {
    sent.push(command);
    return answer(command);
  }) as S3Client["send"];
  return { client, sent };
}

test("presignUploads signs one PUT per file in a fresh folder, with the immutable cache header", async () => {
  const { client } = fakeClient();
  const storage = createStorage(config, { client });
  const { folder, uploads } = await storage.presignUploads({
    filename: "Reel.mov",
    files: [
      { name: "original.mov", contentType: "video/quicktime" },
      { name: "../720p-3b91c0de.mp4", contentType: "video/mp4" },
    ],
  });

  assert.match(folder, /^videos\/reel-\d{13}-[a-z0-9]{8}$/);
  assert.deepEqual(
    uploads.map((upload) => [upload.name, upload.key, upload.publicUrl]),
    [
      ["original.mov", `${folder}/original.mov`, `https://media.example.com/${folder}/original.mov`],
      ["../720p-3b91c0de.mp4", `${folder}/720p-3b91c0de.mp4`, `https://media.example.com/${folder}/720p-3b91c0de.mp4`],
    ]
  );

  const signed = new URL(uploads[0]?.uploadUrl ?? "");
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "3600");
  assert.ok(signed.searchParams.get("X-Amz-Signature"));
  assert.deepEqual(signed.searchParams.get("X-Amz-SignedHeaders")?.split(";"), ["cache-control", "content-type", "host"]);
  assert.equal(signed.searchParams.has("x-amz-checksum-crc32"), false);
  assert.ok(signed.pathname.endsWith(`/${folder}/original.mov`));
});

test("presignDownload accepts a key or a public URL, even under a base path, and forces a named download", async () => {
  const { client } = fakeClient();
  const storage = createStorage({ ...config, publicBaseUrl: "https://cdn.example.com/site/" }, { client });
  const key = "videos/amadee-1755000000000-k3j9x2ab/720p-3b91c0de.mp4";

  for (const input of [key, `/${key}`, `https://cdn.example.com/site/${key}?v=1`]) {
    const signed = new URL(await storage.presignDownload(input));
    assert.equal(signed.searchParams.get("X-Amz-Expires"), "300");
    assert.equal(signed.searchParams.get("response-content-disposition"), 'attachment; filename="amadee-720p-3b91c0de.mp4"');
    assert.ok(signed.pathname.endsWith(`/${key}`));
  }
});

test("presignDownload refuses keys outside the prefix and URLs under another base", async () => {
  const storage = createStorage(config, { client: fakeClient().client });

  await assert.rejects(storage.presignDownload("secrets/a.mp4"), /Invalid object key/);
  await assert.rejects(storage.presignDownload("videos/"), /Invalid object key/);
  await assert.rejects(storage.presignDownload("videos/a/"), /Invalid object key/);
  await assert.rejects(storage.presignDownload("videos/../x.mp4"), /Invalid object key/);
  await assert.rejects(
    storage.presignDownload("https://elsewhere.example.com/videos/a/b.mp4"),
    /not under the storage's public base/
  );
});

test("listAssets pages through the prefix and stops at the limit", async () => {
  const pages = [
    { Contents: [{ Key: "videos/a/original.mp4", Size: 1 }], IsTruncated: true, NextContinuationToken: "t1" },
    { Contents: [{ Key: "videos/b/original.mp4", Size: 1 }], IsTruncated: true, NextContinuationToken: "t2" },
    { Contents: [{ Key: "videos/c/original.mp4", Size: 1 }], IsTruncated: false },
  ];
  const { client, sent } = fakeClient((_command) => pages[sent.length - 1] ?? ({} as never));
  const storage = createStorage({ ...config, keyPrefix: "/videos" }, { client });

  assert.equal((await storage.listAssets()).length, 3);
  assert.deepEqual(
    sent.map((command) => [
      command.input.Bucket,
      (command.input as { Prefix?: string }).Prefix,
      (command.input as { ContinuationToken?: string }).ContinuationToken,
    ]),
    [
      ["media", "videos/", undefined],
      ["media", "videos/", "t1"],
      ["media", "videos/", "t2"],
    ]
  );

  sent.length = 0;
  assert.equal((await storage.listAssets({ limit: 2 })).length, 2);
  assert.equal(sent.length, 2);
});

test("deleteAsset lists the whole folder and deletes it in batches of 1000", async () => {
  const keys = Array.from({ length: 1500 }, (_, index) => `videos/a-1-b/file-${index}.mp4`);
  const { client, sent } = fakeClient((command) =>
    command instanceof ListObjectsV2Command
      ? command.input.ContinuationToken
        ? { Contents: keys.slice(1000).map((Key) => ({ Key })), IsTruncated: false }
        : { Contents: keys.slice(0, 1000).map((Key) => ({ Key })), IsTruncated: true, NextContinuationToken: "t" }
      : {}
  );
  const storage = createStorage(config, { client });

  assert.deepEqual(await storage.deleteAsset("videos/a-1-b/"), { deleted: 1500 });
  const deletes = sent.filter((command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand);
  assert.deepEqual(
    deletes.map((command) => command.input.Delete?.Objects?.length),
    [1000, 500]
  );
  assert.equal((sent[0] as ListObjectsV2Command).input.Prefix, "videos/a-1-b/");
});

test("deleteAsset refuses anything that is not a folder inside the prefix", async () => {
  const { client, sent } = fakeClient();
  const storage = createStorage(config, { client });

  await assert.rejects(storage.deleteAsset(""), /Invalid video id/);
  await assert.rejects(storage.deleteAsset("videos/../other"), /Invalid video id/);
  await assert.rejects(storage.deleteAsset("other/a"), /outside the videos\/ prefix/);
  await assert.rejects(storage.deleteAsset("videos"), /entire videos\/ prefix/);
  await assert.rejects(storage.deleteAsset("videos/"), /entire videos\/ prefix/);
  await assert.rejects(storage.deleteAsset("videosx"), /outside the videos\/ prefix/);
  assert.equal(sent.length, 0);
});

test("deleteAsset surfaces objects the bucket refused to delete", async () => {
  const { client } = fakeClient((command) =>
    command instanceof ListObjectsV2Command
      ? { Contents: [{ Key: "videos/a/original.mp4" }] }
      : { Errors: [{ Key: "videos/a/original.mp4", Code: "AccessDenied" }] }
  );

  await assert.rejects(
    createStorage(config, { client }).deleteAsset("videos/a"),
    /Could not delete 1 object\(s\): videos\/a\/original.mp4 \(AccessDenied\)/
  );
});

test("deleteObjects skips keys outside the prefix and sends nothing when none is left", async () => {
  const { client, sent } = fakeClient();
  const storage = createStorage(config, { client });

  await storage.deleteObjects(["other/a.mp4", "videos/", "videos/../x"]);
  assert.equal(sent.length, 0);

  await storage.deleteObjects(["videos/a/720p-1.mp4", "other/a.mp4"]);
  assert.deepEqual((sent[0] as DeleteObjectsCommand).input.Delete?.Objects, [{ Key: "videos/a/720p-1.mp4" }]);
});

test("putObject writes bytes with the cache header and refuses keys outside the prefix", async () => {
  const { client, sent } = fakeClient();
  const storage = createStorage(config, { client });
  const body = new Uint8Array([1, 2, 3]);

  assert.deepEqual(await storage.putObject({ key: "videos/a/720p-1.mp4", body, contentType: "video/mp4" }), {
    key: "videos/a/720p-1.mp4",
    publicUrl: "https://media.example.com/videos/a/720p-1.mp4",
    bytes: 3,
  });

  const input = (sent[0] as PutObjectCommand).input;
  assert.equal(input.CacheControl, "public, max-age=31536000, immutable");
  assert.equal(input.ContentLength, 3);
  assert.equal(input.ContentType, "video/mp4");
  await assert.rejects(
    storage.putObject({ key: "elsewhere/a.mp4", body, contentType: "video/mp4" }),
    /outside the videos\/ prefix/
  );
});

test("createStorage checks the config on first use, not when it is created", async () => {
  const storage = createStorage({ ...config, bucket: "", publicBaseUrl: "" });

  assert.equal(typeof storage.publicUrl, "function");
  await assert.rejects(storage.listAssets(), /Video storage is not configured: missing bucket, publicBaseUrl\./);
  assert.throws(() => storage.folderFor("a.mp4"), /missing bucket, publicBaseUrl/);
});

test("the helpers read the configured prefix and base", () => {
  const storage = createStorage(
    { ...config, keyPrefix: "clips", publicBaseUrl: "https://cdn.example.com/site" },
    { client: fakeClient().client }
  );

  assert.match(storage.folderFor("a.mp4"), /^clips\/a-\d+-[a-z0-9]{8}$/);
  assert.equal(storage.publicUrl("clips/a/original.mp4"), "https://cdn.example.com/site/clips/a/original.mp4");
  assert.equal(storage.keyFromPublicUrl("https://cdn.example.com/site/clips/a/original.mp4"), "clips/a/original.mp4");
  assert.equal(storage.keyFromPublicUrl("https://cdn.example.com/clips/a/original.mp4"), null);
});
