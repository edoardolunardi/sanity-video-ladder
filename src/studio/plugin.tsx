"use client";

import { ThLargeIcon } from "@sanity/icons/ThLarge";
import { definePlugin, type LayoutProps, type PluginOptions } from "sanity";
import { DEFAULT_TIERS, normalizeTiers } from "../core/renditions.ts";
import { type VideoLadderConfig, VideoLadderProvider } from "./config.tsx";
import { VideoLibraryTool } from "./library/index.ts";
import { createVideoType } from "./schema.tsx";

export type VideoLadderOptions = {
  /** Required: the Studio's API version, read from the host's own config. */
  apiVersion: string;
  /** The host's endpoint, made with `createVideoHandler`. Default `/api/video`. */
  endpoint?: string;
  /** The name the video object type is registered under. Default `video`. */
  typeName?: string;
  /** Every rung height the uploader may produce, and the ladder of a field that sets none of its own.
   *  Default `[240, 720]`. A field picks a subset with `options: { tiers }`. */
  tiers?: readonly number[];
  /** The largest file an editor may pick, in bytes. Default 100 MB. */
  maxFileSize?: number;
  /** Whether the type carries a `playback` field (autoplay, muted, loop, controls). Default true. */
  playback?: boolean;
  /** Whether to add the "Videos" tool, a browser over the whole bucket. Default true. */
  library?: boolean;
};

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;

export function resolveConfig(options: VideoLadderOptions): VideoLadderConfig {
  if (!options?.apiVersion) {
    throw new Error("videoLadder() needs an `apiVersion`, e.g. the one the Studio's own client uses.");
  }

  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  if (!(maxFileSize > 0)) {
    throw new Error(`Invalid maxFileSize ${maxFileSize}: a size in bytes.`);
  }

  return {
    apiVersion: options.apiVersion,
    endpoint: options.endpoint ?? "/api/video",
    typeName: options.typeName ?? "video",
    tiers: normalizeTiers(options.tiers ?? DEFAULT_TIERS),
    maxFileSize,
    playback: options.playback ?? true,
    library: options.library ?? true,
  };
}

/** The Studio plugin: registers the video object type with its upload input and, unless `library` is
 *  false, the "Videos" tool. */
export function videoLadder(options: VideoLadderOptions): PluginOptions {
  const config = resolveConfig(options);

  // Provided around the whole Studio, so the tool and a picker used in a host's own input find the config.
  function Layout(props: LayoutProps) {
    return <VideoLadderProvider config={config}>{props.renderDefault(props)}</VideoLadderProvider>;
  }

  return definePlugin({
    name: `sanity-video-ladder:${config.typeName}`,
    schema: { types: [createVideoType(config)] },
    studio: { components: { layout: Layout } },
    tools: (previous) =>
      config.library
        ? [...previous, { name: "video-library", title: "Videos", icon: ThLargeIcon, component: VideoLibraryTool }]
        : previous,
  })();
}
