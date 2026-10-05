"use client";

import * as React from "react";

/** The plugin's options with every default applied. */
export type VideoLadderConfig = {
  apiVersion: string;
  endpoint: string;
  typeName: string;
  /** Every tier a field may produce, ascending. A field's own `options.tiers` picks from these. */
  tiers: number[];
  maxFileSize: number;
  playback: boolean;
  library: boolean;
};

const VideoLadderContext = React.createContext<VideoLadderConfig | null>(null);

export function VideoLadderProvider({ config, children }: { config: VideoLadderConfig; children: React.ReactNode }) {
  return <VideoLadderContext.Provider value={config}>{children}</VideoLadderContext.Provider>;
}

/** The nearest plugin config. The plugin provides one around the whole Studio and one per video type. */
export function useVideoLadderConfig(): VideoLadderConfig {
  const config = React.useContext(VideoLadderContext);

  if (!config) {
    throw new Error("sanity-video-ladder: add videoLadder() to the plugins of this Studio's config.");
  }

  return config;
}
