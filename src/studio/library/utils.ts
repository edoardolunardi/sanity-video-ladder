import { renditionKey } from "../../core/layout.ts";
import type { Playback } from "../../core/types.ts";
import type { VideoAsset } from "../../storage/list.ts";

/** A video in the bucket, with how many documents use it: `null` while unknown or when the scan failed. */
export type LibraryAsset = VideoAsset & { usedBy: number | null };

/** What a new value plays like until an editor changes it: a silent background loop. */
export const DEFAULT_PLAYBACK: Required<{ [K in keyof Playback]: boolean }> = {
  autoplay: true,
  muted: true,
  loop: true,
  controls: false,
};

/** The playback an existing value carries, with the defaults filling any gap. */
export function playbackFrom(previous: { playback?: Playback | null } | undefined) {
  const playback = previous?.playback;
  return {
    autoplay: playback?.autoplay ?? DEFAULT_PLAYBACK.autoplay,
    muted: playback?.muted ?? DEFAULT_PLAYBACK.muted,
    loop: playback?.loop ?? DEFAULT_PLAYBACK.loop,
    controls: playback?.controls ?? DEFAULT_PLAYBACK.controls,
  };
}

function waitFor<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out."));
    }, timeoutMs);
    const cleanup = start(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function videoSize(src: string) {
  return waitFor<{ width: number; height: number }>((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      video.videoWidth && video.videoHeight
        ? resolve({ width: video.videoWidth, height: video.videoHeight })
        : reject(new Error("No size."));
    video.onerror = () => reject(new Error("Could not read the video's metadata."));
    video.src = src;
    return () => video.removeAttribute("src");
  }, 10_000);
}

function imageSize(src: string) {
  return waitFor<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Could not load the poster."));
    image.src = src;
    return () => image.removeAttribute("src");
  }, 10_000);
}

/** The source's size, read in the browser. The original's own metadata comes first, since it is the true
 *  size; the poster is the fallback and has the right aspect ratio, though it is capped at 1920x1080. A
 *  rung is never asked, since it would report its downscaled height. */
export async function loadAssetDimensions(asset: VideoAsset): Promise<{ width: number; height: number } | null> {
  const original = asset.renditions.find((rendition) => rendition.quality === "original");

  for (const read of [
    original ? () => videoSize(original.url) : null,
    asset.poster ? () => imageSize(asset.poster as string) : null,
  ]) {
    if (!read) {
      continue;
    }

    try {
      return await read();
    } catch {
      // Try the next source; without one, dimensions stay unknown and the site reserves no box.
    }
  }

  return null;
}

/** The value a video field takes when an editor links a video from the library. Everything about the media
 *  comes from the asset; the playback prefs and the array `_key` come from the previous value. A linked
 *  video has no blur placeholder, since one is only made at upload. */
export async function assetToVideoValue(
  asset: VideoAsset,
  previous: { _key?: string; playback?: Playback | null } | undefined,
  options: { typeName: string; playback: boolean }
): Promise<Record<string, unknown>> {
  if (!asset.renditions.length) {
    throw new Error("This video has no playable rendition.");
  }

  const dimensions = await loadAssetDimensions(asset);

  return {
    ...(previous?._key ? { _key: previous._key } : {}),
    _type: options.typeName,
    renditions: asset.renditions.map((rendition) => ({
      _key: renditionKey(rendition.quality),
      _type: "rendition",
      quality: rendition.quality,
      url: rendition.url,
      ...(rendition.poster ? { poster: rendition.poster } : {}),
    })),
    ...(dimensions ? { dimensions } : {}),
    ...(options.playback ? { playback: playbackFrom(previous) } : {}),
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return "-";
  }

  const kb = bytes / 1024;

  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }

  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

export function formatDate(iso: string | null): string {
  if (!iso) {
    return "";
  }

  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function qualityLabel(quality: string): string {
  return quality === "original" ? "Original" : `${quality}p`;
}
