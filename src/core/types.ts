/** A rendition's tag: a rung's height as a string ("240", "720"), or "original" for the untouched source. */
export type Quality = `${number}` | "original";

/** One file of the ladder, as stored in the `renditions` array. */
export type Rendition = { quality?: Quality | null; url?: string | null; poster?: string | null };

export type Playback = {
  autoplay?: boolean | null;
  muted?: boolean | null;
  loop?: boolean | null;
  controls?: boolean | null;
};

/** The stored video object. Every field is optional because a query may project a value only partly. */
export type VideoValue = {
  renditions?: Rendition[] | null;
  placeholder?: string | null;
  dimensions?: { width?: number | null; height?: number | null } | null;
  playback?: Playback | null;
};

/** One `<source>`: `media` is absent on the last one, the fallback. */
export type VideoSource = { media?: string; src: string };

/** One entry of the rules `videoSources` reads: a media condition (absent for the fallback) and a tier. */
export type SourceRule = { media?: string; quality: Quality };
