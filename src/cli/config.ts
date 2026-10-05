import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_TIERS, normalizeTiers } from "../core/renditions.ts";
import type { StorageConfig } from "../storage/config.ts";

/** What `video-ladder.config.ts` default-exports. The host reads its environment inside the file, so the
 *  package never guesses variable names. */
export type VideoLadderCliConfig = {
  sanity: { projectId: string; dataset: string; apiVersion: string; token: string };
  storage: StorageConfig;
  /** The video object's type name, as given to `videoLadder()`. Default `video`. */
  typeName?: string;
  /** The tiers given to `videoLadder()`. Default `[240, 720]`. */
  tiers?: readonly number[];
};

export type ResolvedCliConfig = Required<VideoLadderCliConfig> & { tiers: number[]; path: string };

const CANDIDATES = ["video-ladder.config.ts", "video-ladder.config.mts", "video-ladder.config.mjs", "video-ladder.config.js"];

/** The config file to load: the one passed with `--config`, else the first candidate in the working directory. */
export function findConfigPath(explicit: string | undefined, cwd = process.cwd()): string {
  if (explicit) {
    const path = resolve(cwd, explicit);

    if (!existsSync(path)) {
      throw new Error(`No config file at ${path}.`);
    }

    return path;
  }

  const found = CANDIDATES.map((name) => resolve(cwd, name)).find((path) => existsSync(path));

  if (!found) {
    throw new Error(`No config file found. Add ${CANDIDATES[0]} at ${cwd}, or pass --config <path>.`);
  }

  return found;
}

/** Checks the shape of a loaded config and fills the defaults. Throws naming each missing field. */
export function validateCliConfig(value: unknown, path: string): ResolvedCliConfig {
  const config = (value ?? {}) as Partial<VideoLadderCliConfig>;
  const sanity = (config.sanity ?? {}) as Partial<VideoLadderCliConfig["sanity"]>;
  const missing = (["projectId", "dataset", "apiVersion", "token"] as const)
    .filter((field) => typeof sanity[field] !== "string" || !sanity[field]?.trim())
    .map((field) => `sanity.${field}`);

  if (!config.storage || typeof config.storage !== "object") {
    missing.push("storage");
  }

  if (missing.length) {
    throw new Error(`${path} is missing ${missing.join(", ")}.`);
  }

  return {
    path,
    sanity: sanity as VideoLadderCliConfig["sanity"],
    storage: config.storage as StorageConfig,
    typeName: config.typeName ?? "video",
    tiers: normalizeTiers(config.tiers ?? DEFAULT_TIERS),
  };
}

/** Loads the config file. A `.ts` file runs through Node's own type stripping, so it needs no loader. */
export async function loadCliConfig(explicit: string | undefined): Promise<ResolvedCliConfig> {
  const path = findConfigPath(explicit);
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  return validateCliConfig(module.default, path);
}
