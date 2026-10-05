import { friendlyName, ORIGINAL_POSTER } from "../core/layout.ts";

export type VideoAssetRendition = { quality: string; url: string; container: string; bytes: number; poster?: string };

export type VideoAsset = {
  /** The video's folder key, e.g. `videos/<slug>-<ts>-<rand>`. Stable and unique. */
  id: string;
  name: string;
  /** The original rendition's poster, the thumbnail. Each rendition carries its own on `renditions[].poster`. */
  poster: string | null;
  /** Smallest first, the original last. */
  renditions: VideoAssetRendition[];
  /** Every object in the folder, including replaced revisions a rendition no longer points at. */
  bytes: number;
  updatedAt: string | null;
};

export type ListedObject = { Key?: string; Size?: number; LastModified?: Date };

// Rungs are `<n>p.<ext>` (before revisions) or `<n>p-<rev>.<ext>`, and each poster shares its rung's stem.
// This is the only place a quality is read from a file name; everywhere else it comes from the stored tag.
const RUNG = /^((\d+)p(?:-[a-z0-9]+)?)\.(mp4|webm)$/;
const RUNG_POSTER = /^((\d+)p(?:-[a-z0-9]+)?)-poster\.webp$/;
const ORIGINAL = /^original\.([a-z0-9]+)$/;

type Found = VideoAssetRendition & { stem: string; modified: number };
type Group = {
  bytes: number;
  latest: number;
  renditions: Map<string, Found>;
  posters: Map<string, { url: string; modified: number }>;
};

function qualityOrder(quality: string) {
  return quality === "original" ? Number.POSITIVE_INFINITY : Number(quality);
}

/** The newer of two files for one slot, by last-modified time; on a tie, the later one listed. */
function newer<T extends { modified: number }>(current: T | undefined, candidate: T) {
  return !current || candidate.modified >= current.modified ? candidate : current;
}

/** Rebuilds every video from a flat bucket listing, from the file names alone. When a folder holds two
 *  revisions of one tier (a re-encode whose old file was never deleted), the newest wins, and each
 *  rendition takes the poster written with it. Folders without a playable rendition are left out. */
export function parseListing(objects: readonly ListedObject[], publicUrl: (key: string) => string): VideoAsset[] {
  const groups = new Map<string, Group>();

  for (const object of objects) {
    const key = object.Key;
    const slash = key?.lastIndexOf("/") ?? -1;

    if (!key || slash <= 0) {
      continue;
    }

    const folder = key.slice(0, slash);
    const file = key.slice(slash + 1).toLowerCase();
    const bytes = object.Size ?? 0;
    const modified = object.LastModified?.getTime() ?? 0;
    const group = groups.get(folder) ?? { bytes: 0, latest: 0, renditions: new Map(), posters: new Map() };

    group.bytes += bytes;
    group.latest = Math.max(group.latest, modified);
    groups.set(folder, group);

    const url = publicUrl(key);
    const rung = RUNG.exec(file);
    const original = ORIGINAL.exec(file);
    const rungPoster = RUNG_POSTER.exec(file);

    if (rung?.[1] && rung[2] && rung[3]) {
      const found = { quality: rung[2], url, container: rung[3], bytes, stem: rung[1], modified };
      group.renditions.set(rung[2], newer(group.renditions.get(rung[2]), found));
    } else if (original?.[1]) {
      const found = { quality: "original", url, container: original[1], bytes, stem: "original", modified };
      group.renditions.set("original", newer(group.renditions.get("original"), found));
    } else if (rungPoster?.[1]) {
      group.posters.set(rungPoster[1], newer(group.posters.get(rungPoster[1]), { url, modified }));
    } else if (file === ORIGINAL_POSTER) {
      group.posters.set("original", newer(group.posters.get("original"), { url, modified }));
    }
  }

  const assets: VideoAsset[] = [];

  for (const [folder, group] of groups) {
    if (!group.renditions.size) {
      continue;
    }

    const renditions = [...group.renditions.values()]
      .sort((a, b) => qualityOrder(a.quality) - qualityOrder(b.quality))
      .map(({ stem, modified: _modified, ...rendition }): VideoAssetRendition => {
        const poster = group.posters.get(stem)?.url;
        return poster ? { ...rendition, poster } : rendition;
      });

    assets.push({
      id: folder,
      name: friendlyName(folder),
      poster: group.posters.get("original")?.url ?? null,
      renditions,
      bytes: group.bytes,
      updatedAt: group.latest ? new Date(group.latest).toISOString() : null,
    });
  }

  // Newest first.
  return assets.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
