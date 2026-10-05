"use client";

import { Box, Dialog } from "@sanity/ui";
import { useVideoAssets } from "./data.ts";
import type { LibraryAsset } from "./utils.ts";
import { VideoGrid } from "./video-grid.tsx";

/** A dialog to pick a video already in the bucket. Self-contained, so the bucket is only listed when an
 *  editor opens it, not for every mounted video field. */
export function VideoLibraryPicker({
  onClose,
  onSelect,
  busyId = null,
}: {
  onClose: () => void;
  onSelect: (asset: LibraryAsset) => void;
  busyId?: string | null;
}) {
  const { assets, loading, error, usageError, reload } = useVideoAssets();

  return (
    <Dialog id="video-library-picker" header="Choose a video" width={3} onClose={onClose}>
      <Box padding={4}>
        <VideoGrid
          assets={assets}
          loading={loading}
          error={error}
          usageError={usageError}
          onReload={reload}
          onSelect={onSelect}
          busyId={busyId}
        />
      </Box>
    </Dialog>
  );
}
