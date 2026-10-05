import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@sanity/client";
import { newRevision, ORIGINAL_POSTER, rungFileNames } from "../core/layout.ts";
import { selectShrinkingRenditions } from "../core/renditions.ts";
import type { Quality } from "../core/types.ts";
import { createStorage, type VideoStorage } from "../storage/storage.ts";
import { loadCliConfig } from "./config.ts";
import { hasFfmpeg, probe, run } from "./ffmpeg.ts";
import {
  audioPlanFor,
  buildPosterArgs,
  buildRendition,
  buildTranscodeArgs,
  collectVideoOccurrences,
  type FolderPlan,
  parseTiers,
  planFolders,
  RUNG_CRF,
  renditionFor,
  rungMaxrate,
  type TierPlan,
  tiersToEncode,
} from "./plan.ts";
import {
  confirmOrCancel,
  fail,
  finishDryRun,
  printDone,
  printDryRunNotice,
  printHeader,
  printStep,
  printSummary,
} from "./prompt.ts";

// Generates or regenerates the ladder rungs of every video in the dataset with ffmpeg. Each requested tier
// the source is taller than is transcoded once per folder, uploaded under a fresh versioned key, and written
// into `renditions[]` of every document using the video; replaced files are then deleted. A rung not smaller
// than the next larger kept file is dropped. `--prune` applies that rule to what is already in the bucket,
// `--force` re-encodes existing tiers, `--dry-run` prints the plan.

export type RenditionsOptions = {
  config?: string;
  tiers?: string;
  filter?: string;
  force: boolean;
  prune: boolean;
  dryRun: boolean;
  yes: boolean;
};

type Client = ReturnType<typeof createClient>;

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;
const baseName = (key: string) => key.split("/").pop() ?? key;

async function download(url: string, to: string) {
  const response = await fetch(url);

  if (!response.ok) {
    return false;
  }

  await writeFile(to, Buffer.from(await response.arrayBuffer()));
  return true;
}

/** Uploads occasionally drop the connection mid-body; a fresh attempt after a short pause succeeds. */
async function uploadWithRetry(storage: VideoStorage, props: { key: string; path: string; contentType: string }, attempts = 5) {
  const body = await readFile(props.path);

  for (let attempt = 1; ; attempt++) {
    try {
      return await storage.putObject({ key: props.key, body, contentType: props.contentType });
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      console.log(
        `   ↻  upload of ${baseName(props.key)} failed (${error instanceof Error ? error.message : error}), retrying...`
      );
    }
  }
}

function describe(plan: FolderPlan, tiers: TierPlan[]) {
  const size = plan.height ? `${plan.width ?? "?"}x${plan.height}` : "size unknown";
  const list = tiers.map((tier) => `${tier.tier}p${tier.status === "has-tier" ? " (replace)" : ""}`).join(", ");
  return `${baseName(plan.folder)} (${size}): ${list}`;
}

/** Object keys a rendition points at (its file and its poster). */
function keysOf(storage: VideoStorage, rendition: { url: string; poster?: string }) {
  return [rendition.url, rendition.poster].flatMap((value) => {
    const key = value ? storage.keyFromPublicUrl(value) : null;
    return key ? [key] : [];
  });
}

function docsOf(tiers: TierPlan[]) {
  return new Set(tiers.flatMap((tier) => [...tier.missing, ...tier.present].map((occurrence) => occurrence.documentId)));
}

/** Unsets a tier's rendition from every document that carries it and deletes its objects. */
async function removeTier(client: Client, storage: VideoStorage, tierPlan: TierPlan) {
  const oldKeys = new Set<string>();
  let transaction = client.transaction();
  let patched = 0;

  for (const occurrence of tierPlan.present) {
    const existing = renditionFor(occurrence, tierPlan.tier);

    if (!existing) {
      continue;
    }

    for (const key of keysOf(storage, existing)) {
      oldKeys.add(key);
    }

    transaction = transaction.patch(occurrence.documentId, (patch) =>
      patch.unset([`${occurrence.path}.renditions[_key=="${existing.key}"]`])
    );
    patched++;
  }

  if (patched) {
    await transaction.commit();
    console.log(`   📝 ${tierPlan.tier}p removed from ${tierPlan.present.map((occurrence) => occurrence.documentId).join(", ")}`);
  }

  if (oldKeys.size) {
    await storage.deleteObjects([...oldKeys]);
    console.log(`   🗑️  removed ${[...oldKeys].map(baseName).join(", ")}`);
  }
}

/** The shrinking-size rule applied to what is already in the bucket, without encoding. */
async function prune(client: Client, storage: VideoStorage, plans: FolderPlan[], options: RenditionsOptions) {
  printStep("🔎", "Listing object sizes...");
  const bytesByUrl = new Map<string, number>();
  const originalBytesByFolder = new Map<string, number>();

  for (const asset of await storage.listAssets()) {
    for (const rendition of asset.renditions) {
      bytesByUrl.set(rendition.url, rendition.bytes);

      if (rendition.quality === "original") {
        originalBytesByFolder.set(asset.id, rendition.bytes);
      }
    }
  }

  const oversized: { plan: FolderPlan; tier: TierPlan; rungBytes: number; largerThan: string; largerBytes: number }[] = [];

  for (const plan of plans) {
    const originalBytes = originalBytesByFolder.get(plan.folder);

    if (!originalBytes) {
      continue;
    }

    const present = plan.tiers.filter((entry) => entry.present.length);
    const sized = present.flatMap((tier) => {
      const sample = tier.present[0] && renditionFor(tier.present[0], tier.tier);
      const bytes = sample ? bytesByUrl.get(sample.url) : undefined;
      return bytes === undefined ? [] : [{ quality: `${tier.tier}` as Quality, bytes, tier }];
    });
    const { dropped } = selectShrinkingRenditions([
      { quality: "original" as const, bytes: originalBytes, tier: undefined as TierPlan | undefined },
      ...sized,
    ]);

    for (const { rendition, largerThan } of dropped) {
      if (rendition.tier) {
        oversized.push({
          plan,
          tier: rendition.tier,
          rungBytes: rendition.bytes,
          largerThan: largerThan.quality,
          largerBytes: largerThan.bytes,
        });
      }
    }

    // A rung at or above the source height re-encodes the original at its own size; the original serves that tier.
    for (const tier of present.filter((entry) => entry.status === "too-small")) {
      if (!oversized.some((entry) => entry.tier === tier)) {
        const bytes = sized.find((entry) => entry.tier === tier)?.bytes ?? 0;
        oversized.push({ plan, tier, rungBytes: bytes, largerThan: "original", largerBytes: originalBytes });
      }
    }
  }

  const touched = new Set(oversized.flatMap((entry) => entry.tier.present.map((occurrence) => occurrence.documentId)));

  printSummary([
    { label: "Videos found", value: String(plans.length) },
    { label: "Rungs to drop (not smaller than the next larger file)", value: String(oversized.length) },
    { label: "Documents to patch", value: String(touched.size) },
  ]);

  for (const entry of oversized) {
    const larger = entry.largerThan === "original" ? "original" : `${entry.largerThan}p`;
    console.log(
      `   • ${baseName(entry.plan.folder)} (${entry.plan.width ?? "?"}x${entry.plan.height ?? "?"}): ${entry.tier.tier}p ${megabytes(entry.rungBytes)} vs ${larger} ${megabytes(entry.largerBytes)}`
    );
  }

  console.log("");

  if (!oversized.length) {
    printDone("Nothing to prune.", "Every rung is smaller than the next larger file.");
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (!options.yes) {
    await confirmOrCancel(`Remove ${oversized.length} rungs from the bucket and ${touched.size} documents?`);
  }

  for (const entry of oversized) {
    printStep("🧹", `${baseName(entry.plan.folder)} ${entry.tier.tier}p`);
    await removeTier(client, storage, entry.tier);
  }

  printDone(`Pruned ${oversized.length} rungs.`, `${touched.size} documents patched.`);
}

export async function renditions(options: RenditionsOptions) {
  let config: Awaited<ReturnType<typeof loadCliConfig>>;
  let tiers: number[];

  try {
    config = await loadCliConfig(options.config);
    tiers = parseTiers(options.tiers, config.tiers);
  } catch (error) {
    fail("Could not start.", error instanceof Error ? error.message : String(error));
  }

  printHeader("🎞️", "Video renditions", [
    `Encodes the ${tiers.map((tier) => `${tier}p`).join(", ")} rungs of every video taller than the rung with ffmpeg (libx264 CRF ${RUNG_CRF}),`,
    "uploads each under a fresh versioned key, and writes it into renditions[] wherever the video is used.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  if (!(await hasFfmpeg())) {
    fail("ffmpeg and ffprobe are required.", "Install them (e.g. `brew install ffmpeg`) and make sure both are on the PATH.");
  }

  const storage = createStorage(config.storage);
  const publicBaseUrl = config.storage.publicBaseUrl;
  const { projectId, dataset, apiVersion, token } = config.sanity;
  const client = createClient({ projectId, dataset, apiVersion, token, useCdn: false, perspective: "raw" });

  printStep("🔎", "Reading every document (drafts and published)...");
  const documents = await client.fetch<Record<string, unknown>[]>(
    `*[!(_id in path("_.**")) && !string::startsWith(_type, "sanity.")]`
  );
  const occurrences = collectVideoOccurrences(documents, publicBaseUrl, config.typeName);
  let plans = planFolders(occurrences, tiers);

  if (options.filter) {
    const needle = options.filter.toLowerCase();
    plans = plans.filter((plan) => plan.folder.toLowerCase().includes(needle));
  }

  // A video whose documents store no dimensions decides from the file itself.
  for (const plan of plans.filter((entry) => entry.height === undefined)) {
    try {
      const probed = await probe(plan.originalUrl);
      plan.width = probed.width;
      plan.height = probed.height;

      for (const tier of plan.tiers) {
        if (probed.height <= tier.tier) {
          tier.status = "too-small";
        }
      }
    } catch {
      console.log(`   ⚠️  ${plan.folder}: could not probe the original, skipping.`);
      plan.tiers = [];
    }
  }

  if (options.prune) {
    await prune(client, storage, plans, options);
    return;
  }

  const work = plans
    .map((plan) => ({ plan, tiers: tiersToEncode(plan, options.force).sort((a, b) => b.tier - a.tier) }))
    .filter((entry) => entry.tiers.length);
  const encodes = work.reduce((sum, entry) => sum + entry.tiers.length, 0);
  const replaced = work.reduce((sum, entry) => sum + entry.tiers.filter((tier) => tier.status === "has-tier").length, 0);
  const touchedDocuments = new Set(work.flatMap((entry) => [...docsOf(entry.tiers)]));

  printSummary([
    { label: "Dataset", value: `${projectId}/${dataset}` },
    { label: "Videos found", value: `${plans.length} folders in ${occurrences.length} places` },
    { label: "Tiers", value: tiers.map((tier) => `${tier}p`).join(", ") },
    { label: "Encoder", value: `libx264 CRF ${RUNG_CRF}, preset slow, peak-capped` },
    { label: "To encode", value: `${encodes} rungs across ${work.length} videos (${replaced} replacing existing files)` },
    { label: "Documents to patch", value: String(touchedDocuments.size) },
  ]);

  for (const entry of work) {
    console.log(`   • ${describe(entry.plan, entry.tiers)}`);
  }

  console.log("");

  if (!encodes) {
    printDone(
      "Nothing to do.",
      options.force ? "No source is taller than the requested tiers." : "Every video already has the requested rungs."
    );
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (!options.yes) {
    await confirmOrCancel(`Encode ${encodes} rungs, upload them and patch ${touchedDocuments.size} documents?`);
  }

  // Sizes of files already in the bucket, so a rung can be checked against a larger tier outside this run.
  printStep("🔎", "Listing object sizes...");
  const bytesByUrl = new Map<string, number>();

  for (const asset of await storage.listAssets()) {
    for (const rendition of asset.renditions) {
      bytesByUrl.set(rendition.url, rendition.bytes);
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), "sanity-video-ladder-"));
  let done = 0;
  let failed = 0;

  try {
    for (const [index, { plan, tiers: tierPlans }] of work.entries()) {
      const name = baseName(plan.folder);
      printStep("🎬", `[${index + 1}/${work.length}] ${name}`);

      try {
        const source = join(workDir, `${name}-original`);

        if (!(await download(plan.originalUrl, source))) {
          throw new Error(`could not download ${plan.originalUrl}`);
        }

        const probed = await probe(source);
        const originalBytes = (await stat(source)).size;
        // The smallest larger file kept so far: the original, then each kept rung as the tiers descend.
        let ceiling: { label: string; bytes: number } = { label: "original", bytes: originalBytes };
        const runTiers = new Set<number>(tierPlans.map((entry) => entry.tier));
        const storedPoster = join(workDir, `${name}-${ORIGINAL_POSTER}`);
        const hasStoredPoster = await download(storage.publicUrl(`${plan.folder}/${ORIGINAL_POSTER}`), storedPoster);

        for (const tierPlan of tierPlans) {
          const tier = tierPlan.tier;

          if (probed.height <= tier) {
            console.log(`   ⏭️  ${tier}p: the file is ${probed.width}x${probed.height}, not taller than the rung, skipping.`);
            continue;
          }

          const names = rungFileNames(tier, newRevision());
          const videoKey = `${plan.folder}/${names.video}`;
          const posterKey = `${plan.folder}/${names.poster}`;
          const output = join(workDir, `${name}-${names.video}`);
          const posterOut = join(workDir, `${name}-${names.poster}`);
          const maxrate = rungMaxrate(tier, probed.width, probed.height);

          console.log(
            `   ⚙️  ${tier}p: encoding ${probed.width}x${probed.height} (CRF ${RUNG_CRF}, peak ${Math.round(maxrate / 1000)} kbps)...`
          );
          await run(
            "ffmpeg",
            buildTranscodeArgs({ input: source, output, height: tier, maxrate, audio: audioPlanFor(probed.audioCodec) })
          );
          await run(
            "ffmpeg",
            buildPosterArgs({
              input: hasStoredPoster ? storedPoster : source,
              output: posterOut,
              height: tier,
              fromVideo: !hasStoredPoster,
            })
          );

          // Larger tiers kept outside this run also lower the ceiling.
          for (const existing of plan.occurrences[0]?.renditions ?? []) {
            const existingTier = Number(existing.quality);
            const bytes = bytesByUrl.get(existing.url);

            if (
              Number.isFinite(existingTier) &&
              existingTier > tier &&
              !runTiers.has(existingTier) &&
              bytes &&
              bytes < ceiling.bytes
            ) {
              ceiling = { label: `${existingTier}p`, bytes };
            }
          }

          const rungBytes = (await stat(output)).size;

          if (rungBytes >= ceiling.bytes) {
            console.log(
              `   ⏭️  ${tier}p came out at ${megabytes(rungBytes)}, not smaller than the ${ceiling.label} (${megabytes(ceiling.bytes)}); that file serves this tier.`
            );
            await removeTier(client, storage, tierPlan);
            done++;
            continue;
          }

          ceiling = { label: `${tier}p`, bytes: rungBytes };

          const upload = await uploadWithRetry(storage, { key: videoKey, path: output, contentType: "video/mp4" });
          const posterUpload = await uploadWithRetry(storage, { key: posterKey, path: posterOut, contentType: "image/webp" });
          console.log(`   ⬆️  ${names.video} (${megabytes(upload.bytes)}) + poster`);

          const url = upload.publicUrl;
          const poster = posterUpload.publicUrl;
          const oldKeys = new Set<string>();
          let transaction = client.transaction();

          for (const occurrence of tierPlan.missing) {
            const rendition = buildRendition({ key: randomBytes(6).toString("hex"), tier, url, poster });
            transaction = transaction.patch(occurrence.documentId, (patch) =>
              patch.insert("after", `${occurrence.path}.renditions[-1]`, [rendition])
            );
          }

          for (const occurrence of tierPlan.present) {
            const existing = renditionFor(occurrence, tier);

            if (!existing) {
              continue;
            }

            for (const key of keysOf(storage, existing)) {
              if (key !== videoKey && key !== posterKey) {
                oldKeys.add(key);
              }
            }

            const renditionPath = `${occurrence.path}.renditions[_key=="${existing.key}"]`;
            transaction = transaction.patch(occurrence.documentId, (patch) =>
              patch.set({ [`${renditionPath}.url`]: url, [`${renditionPath}.poster`]: poster })
            );
          }

          await transaction.commit({ autoGenerateArrayKeys: false });
          console.log(`   📝 ${tier}p written to ${[...docsOf([tierPlan])].join(", ")}`);

          if (oldKeys.size) {
            await storage.deleteObjects([...oldKeys]);
            console.log(`   🗑️  removed ${[...oldKeys].map(baseName).join(", ")}`);
          }

          done++;
        }
      } catch (error) {
        failed++;
        console.error(`   ❌ ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (failed) {
    fail(
      `${failed} of ${work.length} videos failed.`,
      `${done} rungs written; run it again with the same flags to retry the rest.`
    );
  }

  printDone(`Wrote ${done} rungs.`, `${touchedDocuments.size} documents patched.`);
}
