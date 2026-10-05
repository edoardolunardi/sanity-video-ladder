"use client";

import { Box, Stack, Text } from "@sanity/ui";
import { useVideoAssets } from "./data.ts";
import { VideoGrid } from "./video-grid.tsx";

export function VideoLibraryTool() {
  const { assets, loading, error, usageError, reload } = useVideoAssets();

  return (
    <Box padding={4} style={{ height: "100%", overflow: "auto" }}>
      <Stack gap={4}>
        <Stack gap={2}>
          <Text size={3} weight="semibold">
            Videos
          </Text>
          <Text size={1} muted>
            Every video in the bucket. Open one to preview it, or pick it from a video field instead of uploading it again. Filter
            to Unused to find videos no document uses, then delete them to clean the bucket.
          </Text>
        </Stack>
        <VideoGrid
          assets={assets}
          loading={loading}
          error={error}
          usageError={usageError}
          onReload={reload}
          columns={[1, 2, 3, 4]}
        />
      </Stack>
    </Box>
  );
}
