import { normalizeTiers } from "../core/renditions.ts";

/** The options a video field may set, e.g. `defineField({ name: "hero", type: "video", options: { tiers: [720] } })`. */
export type VideoFieldOptions = { tiers?: readonly number[] };

/** The ladder for one field: its own `options.tiers` when set, else the plugin's. A field can only pick from
 *  the plugin's tiers, since the stored quality is validated against that list: anything else is left out
 *  and named in `warning`. */
export function resolveFieldTiers(options: unknown, pluginTiers: readonly number[]): { tiers: number[]; warning?: string } {
  const requested = (options as VideoFieldOptions | undefined)?.tiers;

  if (requested === undefined) {
    return { tiers: [...pluginTiers] };
  }

  let normalized: number[];

  try {
    normalized = normalizeTiers(Array.isArray(requested) ? requested : []);
  } catch (error) {
    return {
      tiers: [...pluginTiers],
      warning: `${error instanceof Error ? error.message : "Invalid tiers."} Using ${pluginTiers.join(", ")}.`,
    };
  }

  const tiers = normalized.filter((tier) => pluginTiers.includes(tier));
  const unknown = normalized.filter((tier) => !pluginTiers.includes(tier));

  return unknown.length
    ? {
        tiers,
        warning: `This field asks for ${unknown.map((tier) => `${tier}p`).join(", ")}, which videoLadder({ tiers }) does not list. Add ${
          unknown.length === 1 ? "it" : "them"
        } there to use ${unknown.length === 1 ? "it" : "them"}.`,
      }
    : { tiers };
}
