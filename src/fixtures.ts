// Values the tests share. Excluded from the build, so nothing here ships.

import type { Quality, VideoValue } from "./core/types.ts";

/** A stored value with the original and one rung per tier, under predictable URLs. */
export function ladder(tiers: number[], dimensions = { width: 1920, height: 1080 }): VideoValue {
  return {
    dimensions,
    renditions: [
      { quality: "original", url: "https://m/v/original.mp4" },
      ...tiers.map((tier) => ({ quality: `${tier}` as Quality, url: `https://m/v/${tier}p-abc.mp4` })),
    ],
  };
}

/** What a draft-mode query returns: the value followed by invisible stega characters. */
export function stega(value: string) {
  const marks = "​‌‍﻿";
  return `${value}${Array.from({ length: 40 }, (_, index) => marks[index % 4]).join("")}`;
}
