import type { StorageConfig } from "../storage/config.ts";
import { createStorage, type VideoStorage } from "../storage/storage.ts";

/** Decides whether a request may use the endpoint: nothing to let it through, a Response to deny it. The
 *  Response is returned to the client unchanged. */
export type Authorize = (request: Request) => Response | null | undefined | Promise<Response | null | undefined>;

export type VideoHandlerOptions = {
  /** A storage config (built on first request) or a storage already created with `createStorage`. */
  storage: StorageConfig | VideoStorage;
  /** Required, so the endpoint can never ship open. Typically the host's check of the Studio user's token. */
  authorize: Authorize;
  /** The most files one presign may ask for. The original, its poster and two files per rung must fit. */
  maxFiles?: number;
};

const DEFAULT_MAX_FILES = 16;

function respond(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const fail = (error: string, status: number) => respond({ ok: false, error }, status);

function isVideoStorage(storage: StorageConfig | VideoStorage): storage is VideoStorage {
  return typeof (storage as VideoStorage).presignUploads === "function";
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** The endpoint the Studio talks to: one POST with an `action` of `presign`, `list`, `delete` or `download`.
 *  It never sees a video's bytes. Works anywhere with the Fetch API: export it as `POST` from a Next route
 *  handler, or call it from an Astro endpoint. */
export function createVideoHandler(options: VideoHandlerOptions): (request: Request) => Promise<Response> {
  if (typeof options?.authorize !== "function") {
    throw new Error("createVideoHandler needs an `authorize` function, so the endpoint is never open.");
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error(`Invalid maxFiles ${maxFiles}: a positive whole number.`);
  }

  const storage = isVideoStorage(options.storage) ? options.storage : createStorage(options.storage);
  const { authorize } = options;

  async function run(action: string, work: () => Promise<Record<string, unknown>>) {
    try {
      return respond({ ok: true, ...(await work()) });
    } catch (error) {
      return fail(error instanceof Error && error.message ? error.message : `The ${action} action failed.`, 500);
    }
  }

  return async (request: Request) => {
    const denied = await authorize(request);

    if (denied) {
      return denied;
    }

    if (request.method !== "POST") {
      return Response.json(
        { ok: false, error: "Method not allowed." },
        { status: 405, headers: { allow: "POST", "cache-control": "no-store" } }
      );
    }

    let body: Record<string, unknown>;

    try {
      const parsed: unknown = await request.json();

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return fail("Invalid JSON body.", 400);
      }

      body = parsed as Record<string, unknown>;
    } catch {
      return fail("Invalid JSON body.", 400);
    }

    switch (body.action) {
      case "presign": {
        const filename = text(body.filename) || "video";
        const files = (Array.isArray(body.files) ? body.files : []).flatMap((file: unknown) => {
          const entry = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
          const name = text(entry.name);
          return name ? [{ name, contentType: text(entry.contentType) || "application/octet-stream" }] : [];
        });

        if (!files.length) {
          return fail("No files to presign.", 400);
        }

        if (files.length > maxFiles) {
          return fail(`Too many files (max ${maxFiles}).`, 400);
        }

        return run("presign", () => storage.presignUploads({ filename, files }));
      }

      case "list":
        return run("list", async () => ({ assets: await storage.listAssets() }));

      case "delete": {
        const id = text(body.id);

        if (!id) {
          return fail("Missing video id.", 400);
        }

        return run("delete", () => storage.deleteAsset(id));
      }

      case "download": {
        // A public URL works as well as a key, so a client never has to know how the base URL maps to keys.
        const target = text(body.key) || text(body.url);

        if (!target) {
          return fail("Missing object key or url.", 400);
        }

        return run("download", async () => ({ url: await storage.presignDownload(target) }));
      }

      default:
        return fail("Invalid action.", 400);
    }
  };
}
