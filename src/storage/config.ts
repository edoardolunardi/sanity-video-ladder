import { normalizeKeyPrefix } from "./keys.ts";

/** Where the videos live. Any S3-compatible service works; `r2Storage` fills in Cloudflare R2's endpoint. */
export type StorageConfig = {
  /** The S3 API endpoint: `https://<account>.r2.cloudflarestorage.com`, `https://s3.<region>.amazonaws.com`, a MinIO URL. */
  endpoint: string;
  /** The bucket's region; `"auto"` for R2. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where the site reads objects from, e.g. a custom domain. May include a path segment. */
  publicBaseUrl: string;
  /** Path-style requests (`<endpoint>/<bucket>/<key>`), which MinIO and some other providers need. */
  forcePathStyle?: boolean;
  /** The folder every video lives under. Defaults to `videos/`; normalised to one trailing slash. */
  keyPrefix?: string;
};

/** The Cloudflare R2 preset: the endpoint comes from the account id and the region is `auto`. */
export function r2Storage(config: { accountId: string } & Omit<StorageConfig, "endpoint" | "region">): StorageConfig {
  const { accountId, ...rest } = config;
  const account = accountId?.trim();
  return { ...rest, endpoint: account ? `https://${account}.r2.cloudflarestorage.com` : "", region: "auto" };
}

export type ResolvedStorageConfig = Required<Omit<StorageConfig, "forcePathStyle">> & { forcePathStyle: boolean };

const REQUIRED = ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey", "publicBaseUrl"] as const;

/** Checks every required field and normalises the optional ones. Throws naming each missing field. */
export function resolveStorageConfig(config: StorageConfig): ResolvedStorageConfig {
  const missing = REQUIRED.filter((field) => typeof config?.[field] !== "string" || !config[field].trim());

  if (missing.length) {
    const named = missing.map((field) => (field === "endpoint" ? "endpoint (accountId with r2Storage)" : field));
    throw new Error(`Video storage is not configured: missing ${named.join(", ")}.`);
  }

  return {
    endpoint: config.endpoint.trim(),
    region: config.region.trim(),
    bucket: config.bucket.trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey.trim(),
    publicBaseUrl: config.publicBaseUrl.trim().replace(/\/+$/, ""),
    forcePathStyle: config.forcePathStyle ?? false,
    keyPrefix: normalizeKeyPrefix(config.keyPrefix),
  };
}
