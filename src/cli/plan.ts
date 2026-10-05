// The pure part of the `renditions` command (no process, console, fs or network), so the walk over the
// dataset, the per-folder plan and the ffmpeg command lines are unit tested.

import { normalizeTiers } from "../core/renditions.ts";
import { keyFromPublicUrl } from "../storage/keys.ts";

/** Constant quality (libx264 CRF): a bitrate target derived from the source starves screen recordings.
 *  The peak cap only bounds bursts. */
export const RUNG_CRF = 20;
const PEAK_BITS_PER_PIXEL_SECOND = 4;

type RenditionRef = { _key?: string; quality?: string | null; url?: string | null; poster?: string | null };

export type OccurrenceRendition = { key: string; quality: string; url: string; poster?: string };

export type VideoOccurrence = {
  documentId: string;
  documentType: string;
  /** Sanity JSON path of the video object, e.g. `media[_key=="abc"]` or `body[_key=="x"].video`. */
  path: string;
  /** Object key of the video's folder, e.g. `videos/<slug>-<ts>-<rand>`. */
  folder: string;
  originalUrl: string;
  width?: number;
  height?: number;
  renditions: OccurrenceRendition[];
};

export type TierPlan = {
  tier: number;
  /** Documents that lack this tier entirely (insert) or carry it already (replace when forced). */
  missing: VideoOccurrence[];
  present: VideoOccurrence[];
  status: "generate" | "has-tier" | "too-small";
};

export type FolderPlan = {
  folder: string;
  originalUrl: string;
  /** Source size as stored on the documents (the largest reported wins); undefined when no document has it. */
  height?: number;
  width?: number;
  occurrences: VideoOccurrence[];
  tiers: TierPlan[];
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The folder key of a file URL under `publicBaseUrl`; null for any other URL or a file outside a folder. */
export function folderFromUrl(url: string, publicBaseUrl: string): string | null {
  const key = keyFromPublicUrl(publicBaseUrl, url) ?? "";
  const slash = key.lastIndexOf("/");
  return slash > 0 ? key.slice(0, slash) : null;
}

function segment(key: string, value: unknown, index: number) {
  if (isRecord(value) && typeof value._key === "string") {
    return `[_key=="${value._key}"]`;
  }

  return key ? `.${key}` : `[${index}]`;
}

function walk(value: unknown, path: string, typeName: string, into: (video: Json, path: string) => void) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walk(item, `${path}${segment("", item, index)}`, typeName, into);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  // A video object is recognised by shape: a field of an object type stores no `_type` of its own.
  if (Array.isArray(value.renditions) && (value._type === undefined || value._type === typeName)) {
    into(value, path);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("_")) {
      continue;
    }

    walk(child, path ? `${path}.${key}` : key, typeName, into);
  }
}

/** Every video object in every document (arrays, rich text, nested objects), with its patch path. */
export function collectVideoOccurrences(documents: Json[], publicBaseUrl: string, typeName = "video"): VideoOccurrence[] {
  const found: VideoOccurrence[] = [];

  for (const document of documents) {
    const documentId = typeof document._id === "string" ? document._id : "";
    const documentType = typeof document._type === "string" ? document._type : "";

    if (!documentId) {
      continue;
    }

    walk(document, "", typeName, (video, path) => {
      // The schema requires `quality`, so an untagged rendition is malformed and skipped.
      const renditions = (video.renditions as RenditionRef[]).flatMap((rendition): OccurrenceRendition[] => {
        const quality = rendition?.quality;

        if (!quality || !rendition.url || typeof rendition._key !== "string") {
          return [];
        }

        return [{ key: rendition._key, quality, url: rendition.url, poster: rendition.poster ?? undefined }];
      });
      const original = renditions.find((rendition) => rendition.quality === "original");
      const folder = original ? folderFromUrl(original.url, publicBaseUrl) : null;

      if (!original || !folder) {
        return;
      }

      const dimensions = isRecord(video.dimensions) ? video.dimensions : {};

      found.push({
        documentId,
        documentType,
        path,
        folder,
        originalUrl: original.url,
        width: typeof dimensions.width === "number" ? dimensions.width : undefined,
        height: typeof dimensions.height === "number" ? dimensions.height : undefined,
        renditions,
      });
    });
  }

  return found;
}

export function renditionFor(occurrence: VideoOccurrence, tier: number) {
  return occurrence.renditions.find((rendition) => rendition.quality === String(tier));
}

function tierPlan(group: VideoOccurrence[], height: number | undefined, tier: number): TierPlan {
  const missing = group.filter((occurrence) => !renditionFor(occurrence, tier));
  const present = group.filter((occurrence) => renditionFor(occurrence, tier));
  const status: TierPlan["status"] =
    height !== undefined && height <= tier ? "too-small" : missing.length ? "generate" : "has-tier";
  return { tier, missing, present, status };
}

/** One plan per folder (a file shared by several documents is transcoded once). A tier is `too-small` when
 *  the source is not taller than it, `generate` when some document lacks it, else `has-tier`. */
export function planFolders(occurrences: VideoOccurrence[], tiers: readonly number[]): FolderPlan[] {
  const groups = new Map<string, VideoOccurrence[]>();

  for (const occurrence of occurrences) {
    groups.set(occurrence.folder, [...(groups.get(occurrence.folder) ?? []), occurrence]);
  }

  return [...groups.entries()].map(([folder, group]) => {
    const heights = group.map((occurrence) => occurrence.height).filter((height): height is number => Boolean(height));
    const height = heights.length ? Math.max(...heights) : undefined;
    const width = group.find((occurrence) => occurrence.height === height)?.width;
    const first = group[0] as VideoOccurrence;

    return {
      folder,
      originalUrl: first.originalUrl,
      height,
      width,
      occurrences: group,
      tiers: tiers.map((tier) => tierPlan(group, height, tier)),
    };
  });
}

/** Tiers to encode for a folder: `generate` always, `has-tier` only when forced. */
export function tiersToEncode(plan: FolderPlan, force: boolean) {
  return plan.tiers.filter((tier) => tier.status === "generate" || (force && tier.status === "has-tier"));
}

/** Peak bitrate (bits per second) for the rung: about 4 bits per pixel-second at the rung size. */
export function rungMaxrate(rungHeight: number, srcWidth: number, srcHeight: number) {
  const rungWidth = Math.round((srcWidth / srcHeight) * rungHeight);
  return Math.round(rungWidth * rungHeight * PEAK_BITS_PER_PIXEL_SECOND);
}

export type AudioPlan = "copy" | "aac" | "none";

/** AAC is copied untouched, other codecs are re-encoded to AAC, a silent source stays silent. */
export function audioPlanFor(audioCodec: string | undefined): AudioPlan {
  if (!audioCodec) {
    return "none";
  }

  return audioCodec === "aac" ? "copy" : "aac";
}

/** ffmpeg arguments for one H.264/MP4 rung scaled to `height` (width auto, even): constant quality with
 *  a peak cap (VBV), faststart for streaming. */
export function buildTranscodeArgs(props: { input: string; output: string; height: number; maxrate: number; audio: AudioPlan }) {
  const audio = props.audio === "none" ? ["-an"] : props.audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"];

  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    props.input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=-2:${props.height}`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    String(RUNG_CRF),
    "-maxrate",
    String(props.maxrate),
    "-bufsize",
    String(props.maxrate * 2),
    ...audio,
    "-movflags",
    "+faststart",
    props.output,
  ];
}

/** ffmpeg arguments for the rung's own poster: the stored `poster.webp` (the editor's picked frame)
 *  downscaled to the rung height, never upscaled. With `fromVideo`, one frame at 0.1s is used instead. */
export function buildPosterArgs(props: { input: string; output: string; height: number; fromVideo: boolean }) {
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(props.fromVideo ? ["-ss", "0.1"] : []),
    "-i",
    props.input,
    "-frames:v",
    "1",
    "-vf",
    `scale=-2:'min(${props.height},ih)'`,
    "-c:v",
    "libwebp",
    "-quality",
    "80",
    props.output,
  ];
}

/** The rendition array item written back to Sanity. */
export function buildRendition(props: { key: string; tier: number; url: string; poster: string }) {
  return { _key: props.key, _type: "rendition", quality: String(props.tier), url: props.url, poster: props.poster };
}

/** Parses `--tiers 240,720` against the configured tiers, the vocabulary the Studio's schema accepts. */
export function parseTiers(input: string | undefined, allowed: readonly number[]): number[] {
  if (!input) {
    return [...allowed];
  }

  const requested = input.split(",").map((part) => {
    const value = Number(part.trim());

    if (!allowed.includes(value)) {
      throw new Error(`Unknown tier "${part.trim()}". Use ${allowed.join(", ")}, or add it to the config's tiers.`);
    }

    return value;
  });

  return normalizeTiers(requested);
}
