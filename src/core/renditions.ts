import { stegaClean } from "@sanity/client/stega";
import type { Quality, Rendition, VideoValue } from "./types.ts";

/** The default ladder. It stops at 720 because a 1080p rung of a screen recording measured a median 74%
 *  of the original it was downscaled from at constant quality, so it saved almost nothing; larger slots
 *  are better served the original. A host with other sources can pass its own tiers. */
export const DEFAULT_TIERS = [240, 720] as const;

/** Validates a ladder and returns it sorted and without duplicates. A tier is a rung's height in pixels:
 *  a positive whole number, and even, since H.264 in 4:2:0 cannot encode an odd height. */
export function normalizeTiers(tiers: readonly number[]): number[] {
  for (const tier of tiers) {
    if (!Number.isInteger(tier) || tier <= 0 || tier % 2 !== 0) {
      throw new Error(`Invalid tier ${tier}: a tier is a rung height in pixels, a positive even whole number.`);
    }
  }

  return [...new Set(tiers)].sort((a, b) => a - b);
}

// Unstripped stega breaks `=== "original"` and `Number(...)` in draft mode, silently playing the wrong tier.
function qualityOf(rendition: Rendition): string | undefined {
  const quality = stegaClean(rendition.quality);
  return typeof quality === "string" && quality ? quality : undefined;
}

function playable(renditions: readonly Rendition[] | null | undefined): Rendition[] {
  return (renditions ?? []).filter((rendition): rendition is Rendition => Boolean(rendition?.url));
}

/** The smallest rung at least `minHeight` tall, else the original. `Number.POSITIVE_INFINITY` asks for the original. */
function pickAtLeast(renditions: readonly Rendition[] | null | undefined, minHeight: number): Rendition | undefined {
  const all = playable(renditions);

  if (!all.length) {
    return undefined;
  }

  // "original" has no number, so it drops out here and is only reached as the fallback.
  const tiers = all
    .map((rendition) => ({ rendition, height: Number(qualityOf(rendition)) }))
    .filter((entry) => Number.isFinite(entry.height))
    .sort((a, b) => a.height - b.height);
  const original = all.find((rendition) => qualityOf(rendition) === "original");

  return tiers.find((entry) => entry.height >= minHeight)?.rendition ?? original ?? tiers.at(-1)?.rendition ?? all[0];
}

/** Picks a rendition by tier: the smallest one at or above it, else the original. */
export function pickRendition(
  renditions: readonly Rendition[] | null | undefined,
  quality: Quality = "original"
): Rendition | undefined {
  const tier = stegaClean(quality);
  return pickAtLeast(renditions, tier === "original" ? Number.POSITIVE_INFINITY : Number(tier));
}

/** Whether the value has at least one rendition with a URL, so there is something to play. */
export function hasRenditions(video: VideoValue | null | undefined): boolean {
  return playable(video?.renditions).length > 0;
}

/** Width over height of the source, to reserve the box before the video loads. */
export function videoAspectRatio(video: VideoValue | null | undefined): number | undefined {
  const { width, height } = video?.dimensions ?? {};
  return width && height ? width / height : undefined;
}

function tierOrder(quality: Quality) {
  return quality === "original" ? Number.POSITIVE_INFINITY : Number(quality);
}

/** Keeps a rung only when it is smaller than the next larger kept file, so sizes shrink with the tier.
 *  Constant quality can overshoot a source that was already compressed hard, and such a rung would cost
 *  more bytes for fewer pixels. */
export function selectShrinkingRenditions<T extends { quality: Quality; bytes: number }>(
  renditions: readonly T[]
): { kept: T[]; dropped: { rendition: T; largerThan: T }[] } {
  const sorted = [...renditions].sort((a, b) => tierOrder(b.quality) - tierOrder(a.quality));
  const kept: T[] = [];
  const dropped: { rendition: T; largerThan: T }[] = [];
  let ceiling: T | undefined;

  for (const rendition of sorted) {
    if (ceiling && rendition.bytes >= ceiling.bytes) {
      dropped.push({ rendition, largerThan: ceiling });
      continue;
    }

    kept.push(rendition);
    ceiling = rendition;
  }

  return { kept, dropped };
}
