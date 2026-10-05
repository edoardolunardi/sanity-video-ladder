import { friendlyName } from "../core/layout.ts";

// Object keys: `<prefix><slug>-<timestamp>-<random>/<file>`. One fresh folder per upload, so re-uploading
// never overwrites and a whole video can be listed or deleted by its folder.

/** The folder every video lives under, with exactly one trailing slash. Absent or blank means `videos/`. */
export function normalizeKeyPrefix(prefix: string | undefined) {
  const raw = (prefix ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return raw ? `${raw}/` : "videos/";
}

export function slugifyFilename(filename: string) {
  return (
    filename
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "video"
  );
}

/** A safe, slash-free object name supplied by the browser (`original.mp4`, `720p-3b91c0de.mp4`). */
export function safeName(name: string) {
  return name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^[-.]+/, "") || "file";
}

/** Eight random base-36 characters. */
function randomSuffix() {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join("");
}

/** A fresh folder for one upload. */
export function buildFolder(prefix: string, filename: string, now = Date.now(), suffix = randomSuffix()) {
  return `${prefix}${slugifyFilename(filename)}-${now}-${suffix}`;
}

/** Whether a key or folder sits strictly inside the prefix: never the prefix itself, never with `..`. */
export function isInsidePrefix(key: string, prefix: string) {
  return key.startsWith(prefix) && key.length > prefix.length && !key.includes("..");
}

export function publicUrlFor(publicBaseUrl: string, key: string) {
  return `${publicBaseUrl.replace(/\/+$/, "")}/${key}`;
}

/** The object key of a URL under the public base, or null for any other URL. The base is stripped as a
 *  prefix rather than read off the URL's path, so a base with a path segment of its own works. */
export function keyFromPublicUrl(publicBaseUrl: string, url: string) {
  const base = `${publicBaseUrl.replace(/\/+$/, "")}/`;

  if (!url.startsWith(base)) {
    return null;
  }

  return url.slice(base.length).split(/[?#]/)[0] || null;
}

/** `<video-name>-<file>`, e.g. `amadee-7-720p-3b91c0de.mp4`, so a saved rendition is recognisable on disk. */
export function downloadFilename(key: string) {
  const slash = key.lastIndexOf("/");
  return `${slugifyFilename(friendlyName(key.slice(0, slash)))}-${safeName(key.slice(slash + 1))}`;
}
