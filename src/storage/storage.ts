import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { VIDEO_CACHE_CONTROL } from "../core/layout.ts";
import { type ResolvedStorageConfig, resolveStorageConfig, type StorageConfig } from "./config.ts";
import { buildFolder, downloadFilename, isInsidePrefix, keyFromPublicUrl, publicUrlFor, safeName } from "./keys.ts";
import { type ListedObject, parseListing, type VideoAsset } from "./list.ts";

// The S3 side of the pipeline. Credentials stay on the server, so this is the presigner, the listing and the
// deletes; the browser uploads straight to the bucket through presigned PUTs and the server never handles
// a video's bytes.

export type PresignedUpload = { name: string; key: string; uploadUrl: string; publicUrl: string };

export type VideoStorage = {
  /** One presigned PUT per file inside a fresh folder, plus the public URL each file will have. */
  presignUploads(input: { filename: string; files: { name: string; contentType: string }[] }): Promise<{
    folder: string;
    uploads: PresignedUpload[];
  }>;
  /** A five-minute presigned GET that saves the file under a recognisable name. Takes a key or a public URL. */
  presignDownload(keyOrUrl: string): Promise<string>;
  /** Every video in the bucket, newest first, rebuilt from the file names. */
  listAssets(options?: { limit?: number }): Promise<VideoAsset[]>;
  /** Permanently deletes every object in a video's folder. */
  deleteAsset(folder: string): Promise<{ deleted: number }>;
  /** Deletes specific objects inside the prefix (a replaced rung). Keys outside it are skipped. */
  deleteObjects(keys: string[]): Promise<void>;
  /** Writes one object from memory (the CLI's rungs), with the immutable cache header. */
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<{ key: string; publicUrl: string; bytes: number }>;
  publicUrl(key: string): string;
  keyFromPublicUrl(url: string): string | null;
  /** A fresh folder key for an upload of this file. */
  folderFor(filename: string): string;
};

const UPLOAD_EXPIRY_SECONDS = 3600;
const DOWNLOAD_EXPIRY_SECONDS = 300;
const DEFAULT_LIST_LIMIT = 5000;
const DELETE_BATCH = 1000;
const SIGNED_UPLOAD_HEADERS = new Set(["content-type", "cache-control"]);

/** The storage for one bucket. The config is checked, and the client created, on first use rather than
 *  here, so a host can build its endpoint at import time even where the environment is not set (a build). */
export function createStorage(config: StorageConfig, options: { client?: S3Client } = {}): VideoStorage {
  let resolved: ResolvedStorageConfig | undefined;
  let client: S3Client | undefined = options.client;

  const cfg = () => {
    resolved ??= resolveStorageConfig(config);
    return resolved;
  };

  // One client for the storage's lifetime, so connections are reused across calls.
  const s3 = () => {
    const { endpoint, region, accessKeyId, secretAccessKey, forcePathStyle } = cfg();

    client ??= new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
      // SDK-injected checksum query params on presigned PUTs break browser uploads against S3-compatible providers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });

    return client;
  };

  const publicUrl = (key: string) => publicUrlFor(cfg().publicBaseUrl, key);

  async function deleteKeys(keys: string[]) {
    for (let index = 0; index < keys.length; index += DELETE_BATCH) {
      const batch = keys.slice(index, index + DELETE_BATCH);
      const result = await s3().send(
        new DeleteObjectsCommand({ Bucket: cfg().bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } })
      );
      const failed = result?.Errors ?? [];

      if (failed.length) {
        throw new Error(
          `Could not delete ${failed.length} object(s): ${failed[0]?.Key ?? "?"} (${failed[0]?.Message ?? failed[0]?.Code ?? "unknown"}).`
        );
      }
    }
  }

  async function listKeys(prefix: string, limit = Number.POSITIVE_INFINITY) {
    const objects: ListedObject[] = [];
    let token: string | undefined;

    do {
      const page = await s3().send(new ListObjectsV2Command({ Bucket: cfg().bucket, Prefix: prefix, ContinuationToken: token }));
      objects.push(...(page.Contents ?? []));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && objects.length < limit);

    return objects;
  }

  return {
    async presignUploads({ filename, files }) {
      const { bucket, keyPrefix } = cfg();
      const folder = buildFolder(keyPrefix, filename);

      const uploads = await Promise.all(
        files.map(async (file) => {
          const key = `${folder}/${safeName(file.name)}`;
          const command = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: file.contentType,
            CacheControl: VIDEO_CACHE_CONTROL,
          });
          // Without signableHeaders the presigner signs the host alone and drops both headers, so the object
          // would store whatever the uploader sent. Signed, the PUT must carry exactly these values.
          const uploadUrl = await getSignedUrl(s3(), command, {
            expiresIn: UPLOAD_EXPIRY_SECONDS,
            signableHeaders: SIGNED_UPLOAD_HEADERS,
          });
          return { name: file.name, key, uploadUrl, publicUrl: publicUrl(key) };
        })
      );

      return { folder, uploads };
    },

    async presignDownload(keyOrUrl) {
      const { bucket, keyPrefix, publicBaseUrl } = cfg();
      const input = keyOrUrl.trim();
      const fromUrl = /^https?:\/\//i.test(input) ? keyFromPublicUrl(publicBaseUrl, input) : undefined;

      if (fromUrl === null) {
        throw new Error("That URL is not under the storage's public base URL.");
      }

      const key = (fromUrl ?? input).replace(/^\/+/, "");
      const file = key.slice(key.lastIndexOf("/") + 1);

      if (!file || !isInsidePrefix(key, keyPrefix)) {
        throw new Error("Invalid object key.");
      }

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${downloadFilename(key)}"`,
      });

      return getSignedUrl(s3(), command, { expiresIn: DOWNLOAD_EXPIRY_SECONDS });
    },

    async listAssets({ limit = DEFAULT_LIST_LIMIT } = {}) {
      return parseListing(await listKeys(cfg().keyPrefix, limit), publicUrl);
    },

    async deleteAsset(folder) {
      const { keyPrefix } = cfg();
      const id = folder.trim().replace(/\/+$/, "");
      const folderKey = `${id}/`;

      // The id comes from the browser, so it must name a real folder inside the prefix, never the prefix itself.
      if (!id || id.includes("..")) {
        throw new Error("Invalid video id.");
      }

      if (!folderKey.startsWith(keyPrefix)) {
        throw new Error(`Refusing to delete outside the ${keyPrefix} prefix.`);
      }

      if (folderKey === keyPrefix) {
        throw new Error(`Refusing to delete the entire ${keyPrefix} prefix.`);
      }

      const keys = (await listKeys(folderKey)).flatMap((object) => (object.Key ? [object.Key] : []));
      await deleteKeys(keys);
      return { deleted: keys.length };
    },

    async deleteObjects(keys) {
      const { keyPrefix } = cfg();
      await deleteKeys(keys.filter((key) => isInsidePrefix(key, keyPrefix)));
    },

    async putObject({ key, body, contentType }) {
      const { bucket, keyPrefix } = cfg();

      if (!isInsidePrefix(key, keyPrefix)) {
        throw new Error(`Refusing to write outside the ${keyPrefix} prefix.`);
      }

      // A whole-buffer body can be replayed when the SDK retries a dropped connection; a stream cannot.
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: contentType,
          CacheControl: VIDEO_CACHE_CONTROL,
        })
      );

      return { key, publicUrl: publicUrl(key), bytes: body.byteLength };
    },

    publicUrl,
    keyFromPublicUrl: (url) => keyFromPublicUrl(cfg().publicBaseUrl, url),
    folderFor: (filename) => buildFolder(cfg().keyPrefix, filename),
  };
}
