import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoStorage } from "../storage/storage.ts";
import { type Authorize, createVideoHandler } from "./handler.ts";

const allow: Authorize = async () => null;

/** A storage that records each call and answers from canned values, or throws when told to. */
function fakeStorage(overrides: Partial<VideoStorage> = {}) {
  const calls: [string, unknown][] = [];
  const record =
    <T>(name: string, value: T) =>
    async (input?: unknown) => {
      calls.push([name, input]);
      return value;
    };

  const storage = {
    presignUploads: record("presignUploads", {
      folder: "videos/a-1-b",
      uploads: [
        {
          name: "original.mp4",
          key: "videos/a-1-b/original.mp4",
          uploadUrl: "https://put",
          publicUrl: "https://m/videos/a-1-b/original.mp4",
        },
      ],
    }),
    presignDownload: record("presignDownload", "https://get"),
    listAssets: record("listAssets", [{ id: "videos/a-1-b" }]),
    deleteAsset: record("deleteAsset", { deleted: 4 }),
    ...overrides,
  } as unknown as VideoStorage;

  return { storage, calls };
}

function post(body: unknown, init: RequestInit = {}) {
  return new Request("https://site.example.com/api/video", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

async function read(response: Response) {
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}

test("authorize runs first and its denial is returned unchanged", async () => {
  const { storage, calls } = fakeStorage();
  const denial = new Response("nope", { status: 401, headers: { "x-host": "1" } });
  const handler = createVideoHandler({ storage, authorize: async () => denial });

  const response = await handler(post({ action: "list" }));
  assert.equal(response, denial);
  assert.equal(calls.length, 0);

  // A synchronous authorize, and one that returns undefined, both work.
  const sync = createVideoHandler({ storage, authorize: () => undefined });
  assert.equal((await sync(post({ action: "list" }))).status, 200);
});

test("authorize is required", () => {
  const { storage } = fakeStorage();
  assert.throws(() => createVideoHandler({ storage } as never), /needs an `authorize` function/);
  assert.throws(() => createVideoHandler({ storage, authorize: allow, maxFiles: 0 }), /Invalid maxFiles/);
});

test("a body that is not a JSON object is a 400", async () => {
  const handler = createVideoHandler({ storage: fakeStorage().storage, authorize: allow });

  for (const body of ["{not json", "[1,2]", "null", "42"]) {
    assert.deepEqual(await read(await handler(post(body))), {
      status: 400,
      body: { ok: false, error: "Invalid JSON body." },
      cache: "no-store",
    });
  }
});

test("only POST is served", async () => {
  const handler = createVideoHandler({ storage: fakeStorage().storage, authorize: allow });
  const response = await handler(new Request("https://site.example.com/api/video"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("presign hands the files to storage and answers with the folder and uploads", async () => {
  const { storage, calls } = fakeStorage();
  const handler = createVideoHandler({ storage, authorize: allow });
  const response = await read(
    await handler(
      post({
        action: "presign",
        filename: " Reel.mov ",
        files: [{ name: "original.mov", contentType: "video/quicktime" }, { name: "poster.webp" }, { name: "" }, null, "x"],
      })
    )
  );

  assert.equal(response.status, 200);
  assert.equal(response.cache, "no-store");
  assert.deepEqual(response.body, {
    ok: true,
    folder: "videos/a-1-b",
    uploads: [
      {
        name: "original.mp4",
        key: "videos/a-1-b/original.mp4",
        uploadUrl: "https://put",
        publicUrl: "https://m/videos/a-1-b/original.mp4",
      },
    ],
  });
  assert.deepEqual(calls, [
    [
      "presignUploads",
      {
        filename: "Reel.mov",
        files: [
          { name: "original.mov", contentType: "video/quicktime" },
          { name: "poster.webp", contentType: "application/octet-stream" },
        ],
      },
    ],
  ]);
});

test("presign refuses no files and more than maxFiles", async () => {
  const handler = createVideoHandler({ storage: fakeStorage().storage, authorize: allow, maxFiles: 2 });
  const files = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `f${index}.mp4`, contentType: "video/mp4" }));

  assert.deepEqual((await read(await handler(post({ action: "presign" })))).body, { ok: false, error: "No files to presign." });
  assert.deepEqual((await read(await handler(post({ action: "presign", files: [] })))).status, 400);
  assert.equal((await handler(post({ action: "presign", files: files(2) }))).status, 200);
  assert.deepEqual(await read(await handler(post({ action: "presign", files: files(3) }))), {
    status: 400,
    body: { ok: false, error: "Too many files (max 2)." },
    cache: "no-store",
  });
});

test("presign defaults the file name", async () => {
  const { storage, calls } = fakeStorage();
  await createVideoHandler({ storage, authorize: allow })(
    post({ action: "presign", files: [{ name: "a.mp4", contentType: "video/mp4" }] })
  );
  assert.equal((calls[0]?.[1] as { filename?: string } | undefined)?.filename, "video");
});

test("list answers with the assets", async () => {
  const handler = createVideoHandler({ storage: fakeStorage().storage, authorize: allow });
  assert.deepEqual((await read(await handler(post({ action: "list" })))).body, { ok: true, assets: [{ id: "videos/a-1-b" }] });
});

test("delete needs an id and answers with the count", async () => {
  const { storage, calls } = fakeStorage();
  const handler = createVideoHandler({ storage, authorize: allow });

  assert.deepEqual(await read(await handler(post({ action: "delete", id: "  " }))), {
    status: 400,
    body: { ok: false, error: "Missing video id." },
    cache: "no-store",
  });
  assert.deepEqual((await read(await handler(post({ action: "delete", id: " videos/a-1-b " })))).body, { ok: true, deleted: 4 });
  assert.deepEqual(calls, [["deleteAsset", "videos/a-1-b"]]);
});

test("download takes a key or a url", async () => {
  const { storage, calls } = fakeStorage();
  const handler = createVideoHandler({ storage, authorize: allow });

  assert.deepEqual((await read(await handler(post({ action: "download" })))).body, {
    ok: false,
    error: "Missing object key or url.",
  });
  assert.deepEqual((await read(await handler(post({ action: "download", key: "videos/a/720p.mp4" })))).body, {
    ok: true,
    url: "https://get",
  });
  await handler(post({ action: "download", url: "https://m/videos/a/720p.mp4" }));
  assert.deepEqual(calls, [
    ["presignDownload", "videos/a/720p.mp4"],
    ["presignDownload", "https://m/videos/a/720p.mp4"],
  ]);
});

test("an unknown action is a 400", async () => {
  const handler = createVideoHandler({ storage: fakeStorage().storage, authorize: allow });

  for (const action of ["purge", undefined, 7]) {
    assert.deepEqual((await read(await handler(post({ action })))).body, { ok: false, error: "Invalid action." });
  }
});

test("a storage error is a 500 carrying its message", async () => {
  const { storage } = fakeStorage({
    listAssets: async () => {
      throw new Error("Video storage is not configured: missing bucket.");
    },
    deleteAsset: async () => {
      throw "not an error";
    },
  });
  const handler = createVideoHandler({ storage, authorize: allow });

  assert.deepEqual(await read(await handler(post({ action: "list" }))), {
    status: 500,
    body: { ok: false, error: "Video storage is not configured: missing bucket." },
    cache: "no-store",
  });
  assert.deepEqual((await read(await handler(post({ action: "delete", id: "videos/a" })))).body, {
    ok: false,
    error: "The delete action failed.",
  });
});

test("a storage config is turned into a storage on first use, so a missing field is a 500, not a crash", async () => {
  const handler = createVideoHandler({
    authorize: allow,
    storage: { endpoint: "", region: "auto", bucket: "b", accessKeyId: "i", secretAccessKey: "s", publicBaseUrl: "https://m" },
  });

  assert.deepEqual(await read(await handler(post({ action: "list" }))), {
    status: 500,
    body: { ok: false, error: "Video storage is not configured: missing endpoint (accountId with r2Storage)." },
    cache: "no-store",
  });
});
