import * as React from "react";
import type { SanityClient } from "sanity";
import type { VideoAsset } from "../../storage/list.ts";
import { useVideoApi, type VideoApiCall } from "../studio-fetch.ts";
import type { LibraryAsset } from "./utils.ts";

// The library's data: the bucket listing from the host's endpoint, and where each video is used.
//
// Videos are stored as plain URLs, not asset references, so there is no reference graph to walk. A
// document uses a video when its JSON contains the video's folder key between slashes (`/<id>/`), which
// needs no knowledge of the key prefix and never confuses `videos/foo-1` with `videos/foo-12`. The usage
// count and the details dialog's reference list scan the same documents the same way, so a video the grid
// marks Unused is exactly one the dialog lets you delete.

type Doc = Record<string, unknown> & { _id: string; _type: string };

const PAGE = 500;

/** Every document in the dataset (drafts and release versions included, system documents not), paged by
 *  `_id` so a large dataset is scanned whole rather than cut at a limit. A cut would mark a video used by
 *  a later document as unused, and let it be deleted. */
async function fetchScannableDocs(client: SanityClient): Promise<Doc[]> {
  const raw = client.withConfig({ perspective: "raw" });
  const docs: Doc[] = [];
  let last = "";

  for (;;) {
    const page = await raw.fetch<Doc[]>(
      `*[!(_id in path("_.**")) && !(_type match "sanity.*") && _id > $last] | order(_id) [0...${PAGE}]`,
      { last }
    );
    docs.push(...page);

    if (page.length < PAGE) {
      return docs;
    }

    last = page[page.length - 1]?._id ?? last;
  }
}

/** A draft, its release versions and the published document are one document here. */
function baseId(id: string) {
  return id.replace(/^drafts\./, "").replace(/^versions\.[^.]+\./, "");
}

const marker = (assetId: string) => `/${assetId}/`;

/** How many documents use each video. */
export async function loadUsage(client: SanityClient, assetIds: readonly string[]): Promise<Map<string, number>> {
  const users = new Map<string, Set<string>>(assetIds.map((id) => [id, new Set()]));

  for (const doc of await fetchScannableDocs(client)) {
    const text = JSON.stringify(doc);

    for (const [assetId, ids] of users) {
      if (text.includes(marker(assetId))) {
        ids.add(baseId(doc._id));
      }
    }
  }

  return new Map([...users].map(([assetId, ids]) => [assetId, ids.size]));
}

export type ReferencingDoc = { id: string; type: string; title: string };

function titleOf(doc: Doc) {
  const nested = (key: string, field: string) => (doc[key] as Record<string, unknown> | undefined)?.[field];
  const candidates = [doc.title, doc.name, nested("seo", "title"), nested("uri", "current"), nested("slug", "current")];
  return (candidates.find((value) => typeof value === "string" && value.trim()) as string | undefined) ?? baseId(doc._id);
}

/** The documents that use one video, for the details dialog. */
export async function findReferencingDocs(client: SanityClient, assetId: string): Promise<ReferencingDoc[]> {
  const found = new Map<string, ReferencingDoc>();

  for (const doc of await fetchScannableDocs(client)) {
    const id = baseId(doc._id);

    if (!found.has(id) && JSON.stringify(doc).includes(marker(assetId))) {
      found.set(id, { id, type: doc._type, title: titleOf(doc) });
    }
  }

  return [...found.values()];
}

type ListState = {
  assets: LibraryAsset[];
  loading: boolean;
  error: string | null;
  usageError: string | null;
  reload: () => void;
};

/** The bucket's videos with their usage. Listed when mounted, so the bucket is only read when a library opens. */
export function useVideoAssets(): ListState {
  const { call, client } = useVideoApi();
  const [assets, setAssets] = React.useState<LibraryAsset[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [usageError, setUsageError] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setUsageError(null);

    (async () => {
      const { assets: listed } = await call<{ assets: VideoAsset[] }>({ action: "list" }, "Could not load videos");

      if (!alive) {
        return;
      }

      // Show the videos straight away; usage follows, and stays unknown (never "unused") if its scan fails.
      setAssets(listed.map((asset) => ({ ...asset, usedBy: null })));
      setLoading(false);

      try {
        const usage = await loadUsage(
          client,
          listed.map((asset) => asset.id)
        );

        if (alive) {
          setAssets(listed.map((asset) => ({ ...asset, usedBy: usage.get(asset.id) ?? 0 })));
        }
      } catch (scanError) {
        if (alive) {
          setUsageError(scanError instanceof Error ? scanError.message : "Could not check where videos are used.");
        }
      }
    })().catch((listError) => {
      if (alive) {
        setError(listError instanceof Error ? listError.message : "Could not load videos.");
        setLoading(false);
      }
    });

    return () => {
      alive = false;
    };
  }, [call, client]);

  React.useEffect(() => reload(), [reload]);

  return { assets, loading, error, usageError, reload };
}

export async function deleteAsset(call: VideoApiCall, id: string): Promise<void> {
  await call({ action: "delete", id }, "Delete failed");
}

/** A presigned GET that saves the file. It sends the public URL itself, so the Studio never has to know how
 *  the storage's public base maps to object keys. */
export async function presignDownload(call: VideoApiCall, url: string): Promise<string> {
  const { url: signed } = await call<{ url: string }>({ action: "download", url }, "Download failed");
  return signed;
}
