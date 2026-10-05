// How a video's files are named in the bucket and in the stored value. The Studio, the storage helpers and
// the CLI all read these, so a name cannot drift between the writer and the parser. Existing documents and
// objects depend on every string here: change none of them without a migration.

/** Every object is written under a key that never changes content: the original and `poster.webp` once per
 *  folder, each rung under its own revision. That is what makes a year-long immutable cache safe, and it
 *  lives with the pipeline rather than in a CDN rule, so the bucket tells the truth on any path that reads
 *  it. It is signed into the presigned PUT, so the browser must send the same value back and the bucket
 *  CORS policy must allow the `cache-control` request header. */
export const VIDEO_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The original rendition's poster, also the asset's thumbnail. Written once per folder. */
export const ORIGINAL_POSTER = "poster.webp";

/** `original.<ext>`, the untouched source. Written once per folder. */
export function originalFileName(extension: string) {
  return `original.${extension.toLowerCase().replace(/^\.+/, "") || "mp4"}`;
}

/** A random eight-character hex revision. Every rung write gets a new one, so no write ever lands on a
 *  URL an edge cache may still hold. */
export function newRevision() {
  return (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0).toString(16).padStart(8, "0");
}

/** Versioned object names for one rung and its own poster, e.g. `720p-3b91c0de.mp4`. */
export function rungFileNames(height: number, revision: string) {
  return { video: `${height}p-${revision}.mp4`, poster: `${height}p-${revision}-poster.webp` };
}

/** The array `_key` the Studio gives a rendition, stable across re-uploads of the same field. */
export function renditionKey(quality: string) {
  return quality === "original" ? "original" : `mp4-${quality}`;
}

/** A folder's display name: the last path segment without its `-<timestamp>-<random>` suffix, separators
 *  turned into spaces, so `videos/glyph-field-0-1755000000000-k3j9x2ab` reads "glyph field 0". */
export function friendlyName(folder: string) {
  const segment = folder.replace(/\/+$/, "").split("/").pop() || folder;
  const base = segment.replace(/-\d{10,}-[a-z0-9]+$/i, "") || segment;
  return base.replace(/[-_]+/g, " ").trim() || segment;
}

/** The display name of the video a file URL belongs to: its folder is the second-to-last path segment. */
export function friendlyNameFromUrl(url: string) {
  let path: string;

  try {
    path = new URL(url).pathname;
  } catch {
    return "";
  }

  const folder = path.split("/").filter(Boolean).at(-2);

  if (!folder) {
    return "";
  }

  try {
    return friendlyName(decodeURIComponent(folder));
  } catch {
    return friendlyName(folder);
  }
}
