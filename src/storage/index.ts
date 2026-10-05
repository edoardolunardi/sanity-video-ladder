/** The shape `video-ladder.config.ts` default-exports, for the CLI. */
export type { VideoLadderCliConfig } from "../cli/config.ts";
export { r2Storage, type StorageConfig } from "./config.ts";
export type { VideoAsset, VideoAssetRendition } from "./list.ts";
export { createStorage, type PresignedUpload, type VideoStorage } from "./storage.ts";
