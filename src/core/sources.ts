import { pickRendition } from "./renditions.ts";
import type { Quality, Rendition, SourceRule, VideoSource } from "./types.ts";

function parseQuality(value: string, entry: string): Quality {
  if (value === "original" || /^\d+$/.test(value)) {
    return value as Quality;
  }

  throw new Error(`Invalid quality "${value}" in "${entry}": end each entry with a tier height like 720, or original.`);
}

/** Splits on the commas between entries, not on any inside a media condition's parentheses. */
function entries(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Reads a string written like an `<img sizes>` attribute, with a tier where `sizes` has a width:
 *  `"(min-width: 64rem) original, (min-width: 48rem) 720, 240"`. Each entry is an optional media condition
 *  and a tier; the condition is kept exactly as written. */
export function parseSourceRules(value: string): SourceRule[] {
  return entries(value).map((entry) => {
    const split = entry.lastIndexOf(" ");
    const media = split === -1 ? "" : entry.slice(0, split).trim();
    const quality = parseQuality(entry.slice(split + 1), entry);
    return media ? { media, quality } : { quality };
  });
}

/** One `<source>` per rule, for a `<video>` that should load a smaller rung on a smaller screen.
 *
 *  `rules` reads like an `<img sizes>` attribute with a tier in place of the width, e.g.
 *  `"(min-width: 48rem) original, 720"`, or is the same as an array of `{ media, quality }`. As with
 *  `sizes`, the first matching condition wins and the first entry without one is the fallback (the original
 *  when there is none); entries after the fallback can never match and are ignored. Each tier resolves with
 *  `pickRendition`, so a missing rung falls back to the next larger file. Trailing sources that repeat the
 *  fallback are dropped, so "720" and "(min-width: 48rem) 720, 720" both give a single source.
 *
 *  Selection happens here, at render time, because a browser plays the first `<source>` it can decode
 *  whatever its size. For any other logic, call `pickRendition` directly and build the sources yourself. */
export function videoSources(
  renditions: readonly Rendition[] | null | undefined,
  rules: string | readonly SourceRule[]
): VideoSource[] {
  const list = typeof rules === "string" ? parseSourceRules(rules) : rules;
  const fallbackIndex = list.findIndex((rule) => !rule.media?.trim());
  const conditional = fallbackIndex === -1 ? list : list.slice(0, fallbackIndex);
  const urlFor = (quality: Quality) => pickRendition(renditions, quality)?.url ?? undefined;
  const fallbackSrc = urlFor(fallbackIndex === -1 ? "original" : (list[fallbackIndex]?.quality ?? "original"));

  if (!fallbackSrc) {
    return [];
  }

  const sources = conditional.flatMap((rule): VideoSource[] => {
    const src = urlFor(rule.quality);
    return src && rule.media ? [{ media: rule.media.trim(), src }] : [];
  });

  let end = sources.length;

  while (end > 0 && sources[end - 1]?.src === fallbackSrc) {
    end--;
  }

  return [...sources.slice(0, end), { src: fallbackSrc }];
}
