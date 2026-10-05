"use client";

import { InfoOutlineIcon } from "@sanity/icons/InfoOutline";
import { ThLargeIcon } from "@sanity/icons/ThLarge";
import { UploadIcon } from "@sanity/icons/Upload";
import { Box, Button, Card, Checkbox, Flex, Spinner, Stack, Text } from "@sanity/ui";
import { Tooltip } from "@sanity/ui/tooltip";
import * as React from "react";
import { type ObjectInputProps, set } from "sanity";
import { newRevision, ORIGINAL_POSTER, originalFileName, renditionKey, rungFileNames } from "../../core/layout.ts";
import { selectShrinkingRenditions } from "../../core/renditions.ts";
import type { Playback, Quality } from "../../core/types.ts";
import { useVideoLadderConfig } from "../config.tsx";
import { VideoLibraryPicker } from "../library/index.ts";
import { assetToVideoValue, type LibraryAsset, playbackFrom } from "../library/utils.ts";
import { useVideoApi } from "../studio-fetch.ts";
import { resolveFieldTiers } from "../tiers.ts";
import type { Probe } from "./media.ts";
import { ProbeNotice } from "./probe-notice.tsx";
import { uploadFiles } from "./upload.ts";

// The input for the video object. The browser does all the work with MediaBunny (./media): decode the
// poster frame and dimensions, transcode the H.264/MP4 rungs, then upload each rung and its own sized
// poster straight to the bucket (./upload). Everything lives in `renditions[]` (the untouched original is
// just a rendition); the site paints the top-level `placeholder` blur. A picked file is probed up front and
// rejected with re-export guidance when the browser cannot decode it, so an upload never fails part-way.

type Rendition = { _key?: string; _type?: "rendition"; quality?: Quality; url?: string; poster?: string };

type VideoValue = {
  _key?: string;
  _type?: string;
  renditions?: Rendition[];
  placeholder?: string;
  dimensions?: { width?: number; height?: number };
  playback?: Playback;
};

type Stage = "idle" | "preparing" | "transcoding" | "uploading";

// MediaBunny is only needed once an editor picks a file, so it stays out of the Studio's initial bundle.
let media: Promise<typeof import("./media.ts")> | undefined;
const loadMedia = () => {
  media ??= import("./media.ts");
  return media;
};

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getExtension(filename: string, fallback: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1];
  return extension ? extension.toLowerCase() : fallback;
}

// The video currently on the field: the original rendition, looping muted, so it is obvious which clip is
// linked without reading the renditions list. Falls back to the poster while it loads, and to the first
// rendition if there is somehow no original.
function CurrentVideoPreview({ value }: { value: VideoValue }) {
  const renditions = value.renditions ?? [];
  const original = renditions.find((r) => r.quality === "original") ?? renditions[0];
  const src = original?.url;

  if (!src) {
    return null;
  }

  const dims = value.dimensions;
  const meta = [dims?.width && dims?.height ? `${dims.width}×${dims.height}` : null, `${renditions.length} rendition(s)`]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card border padding={3} radius={2} tone="transparent">
      <Stack gap={3}>
        <Flex align="center" justify="space-between" gap={2}>
          <Text size={1} weight="semibold">
            Current video
          </Text>
          <Text size={1} muted>
            {meta}
          </Text>
        </Flex>
        <video
          key={src}
          src={src}
          poster={original?.poster ?? undefined}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          style={{ width: "100%", maxHeight: 320, borderRadius: 4, background: "#000", objectFit: "contain" }}
        />
      </Stack>
    </Card>
  );
}

export function VideoInput(props: ObjectInputProps<Record<string, unknown>>) {
  const value = props.value as VideoValue | undefined;
  const config = useVideoLadderConfig();
  const { call, hasToken } = useVideoApi();
  const { tiers, warning: tiersWarning } = React.useMemo(
    () => resolveFieldTiers(props.schemaType.options, config.tiers),
    [props.schemaType.options, config.tiers]
  );

  const [file, setFile] = React.useState<File | null>(null);
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<Probe | null>(null);
  const [duration, setDuration] = React.useState(0);
  const [sourceHeight, setSourceHeight] = React.useState(0);
  const [posterTime, setPosterTime] = React.useState(0);
  const [ladder, setLadder] = React.useState<number[]>(tiers);
  const [stage, setStage] = React.useState<Stage>("idle");
  const [progress, setProgress] = React.useState(0);
  const [stageLabel, setStageLabel] = React.useState("");
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [applying, setApplying] = React.useState<string | null>(null);

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const probeToken = React.useRef(0);

  const isBusy = stage !== "idle";
  const renditionCount = value?.renditions?.length ?? 0;
  const canUpload = hasToken && Boolean(file) && probe?.state === "ok" && !isBusy;

  React.useEffect(() => {
    setLadder(tiers);
  }, [tiers]);

  React.useEffect(() => {
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  React.useEffect(() => {
    if (!isBusy) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);

    return () => {
      window.clearInterval(interval);
    };
  }, [isBusy]);

  const onSelectFile = (next: File | null) => {
    setError(null);
    setSuccess(null);
    probeToken.current += 1;

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

    if (!next) {
      setFile(null);
      setObjectUrl(null);
      setProbe(null);
      return;
    }

    if (next.size > config.maxFileSize) {
      setError(`File too large (${formatMegabytes(next.size)}). Maximum allowed size is ${formatMegabytes(config.maxFileSize)}.`);
      setFile(null);
      setObjectUrl(null);
      setProbe(null);
      return;
    }

    setFile(next);
    setObjectUrl(URL.createObjectURL(next));
    setProbe({ state: "checking" });

    // The token guards against an out-of-order result when a newer file is picked mid-probe.
    const token = probeToken.current;
    loadMedia()
      .then(({ probeFile }) => probeFile(next))
      .then((result) => {
        if (token === probeToken.current) {
          setProbe(result);
        }
      })
      .catch(() => {
        if (token === probeToken.current) {
          setProbe({ state: "unsupported", summary: next.name, reason: "This file could not be read." });
        }
      });
  };

  const onLoadedMetadata = () => {
    const node = videoRef.current;

    if (!node) {
      return;
    }

    setDuration(node.duration || 0);
    const height = node.videoHeight || 0;
    setSourceHeight(height);
    setLadder(tiers.filter((tier) => !height || tier <= height));
    const initial = Math.min(0.1, (node.duration || 0) / 10);
    setPosterTime(initial);
    node.currentTime = initial;
  };

  const onScrub = (time: number) => {
    setPosterTime(time);

    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  const toggleRung = (height: number) => {
    setLadder((prev) => (prev.includes(height) ? prev.filter((x) => x !== height) : [...prev, height].sort((a, b) => a - b)));
  };

  const handleUpload = async () => {
    if (!file) {
      setError("Select a video file first.");
      return;
    }

    if (probe?.state !== "ok") {
      setError("This file can't be processed in the browser. Re-export it and pick it again.");
      return;
    }

    setError(null);
    setSuccess(null);
    setProgress(0);

    try {
      const { computeLadder, decodePosterFrame, encodePosterWebp, prepareEncoder, rungQuality, transcodeRung } =
        await loadMedia();
      const codec = await prepareEncoder();

      setStage("preparing");
      setStageLabel("Extracting poster");
      const frame = await decodePosterFrame({ file, timeSec: posterTime });
      setProgress(0.05);

      // Progress spans 5% to 70%, weighted by each rung's pixel area.
      setStage("transcoding");
      const rungs = computeLadder(frame.height, ladder);
      const plan = rungs.map((height) => ({ height, weight: height * height }));
      const totalWeight = plan.reduce((sum, p) => sum + p.weight, 0) || 1;
      let doneWeight = 0;
      const transcoded: { blob: Blob; height: number }[] = [];

      for (const [index, { height, weight }] of plan.entries()) {
        setStageLabel(`Transcoding ${height}p (${index + 1} of ${plan.length})`);
        const blob = await transcodeRung({
          file,
          height,
          codec,
          quality: rungQuality(height, frame.width, frame.height),
          onProgress: (fraction) => setProgress(0.05 + ((doneWeight + weight * fraction) / totalWeight) * 0.65),
        });
        doneWeight += weight;
        transcoded.push({ blob, height });
      }

      // A rung not smaller than the next larger kept file costs more bytes for fewer pixels: drop and report it.
      const { kept, dropped } = selectShrinkingRenditions([
        { quality: "original" as const, bytes: file.size, height: frame.height },
        ...transcoded.map((rung) => ({ quality: `${rung.height}` as Quality, bytes: rung.blob.size, height: rung.height })),
      ]);
      const keptHeights = new Set(kept.map((rung) => rung.height));
      const skipped = dropped.map(
        ({ rendition, largerThan }) =>
          `${rendition.quality}p (${formatMegabytes(rendition.bytes)}) is not smaller than the ${
            largerThan.quality === "original" ? "original" : `${largerThan.quality}p`
          } (${formatMegabytes(largerThan.bytes)})`
      );
      // Each rung gets a random revision in its name, so a later re-encode is a new URL and never a stale
      // edge-cache hit.
      const rungOutputs = transcoded
        .filter((rung) => keptHeights.has(rung.height))
        .map((rung) => {
          const names = rungFileNames(rung.height, newRevision());
          return { name: names.video, posterName: names.poster, blob: rung.blob, height: rung.height };
        });

      // One poster per rendition from the same picked frame: the original full size, each rung downscaled.
      const originalPosterBlob = await encodePosterWebp(frame.canvas);
      const rungPosters = await Promise.all(
        rungOutputs.map(async (rung) => ({
          posterName: rung.posterName,
          blob: await encodePosterWebp(frame.canvas, rung.height),
        }))
      );

      // Progress spans 70% to 100%.
      setStage("uploading");
      setStageLabel("Uploading to storage");
      const originalName = originalFileName(getExtension(file.name, "mp4"));

      const publicUrls = await uploadFiles({
        call,
        filename: file.name,
        files: [
          { name: originalName, body: file, contentType: file.type || "video/mp4" },
          ...rungOutputs.map((rung) => ({ name: rung.name, body: rung.blob, contentType: "video/mp4" })),
          { name: ORIGINAL_POSTER, body: originalPosterBlob, contentType: "image/webp" },
          ...rungPosters.map((poster) => ({ name: poster.posterName, body: poster.blob, contentType: "image/webp" })),
        ],
        onProgress: (fraction) => setProgress(0.7 + fraction * 0.3),
      });

      const originalUrl = publicUrls.get(originalName);

      if (!originalUrl) {
        throw new Error("The original upload did not return a URL.");
      }

      setProgress(1);

      const renditions: Rendition[] = [
        {
          _key: renditionKey("original"),
          _type: "rendition",
          quality: "original",
          url: originalUrl,
          poster: publicUrls.get(ORIGINAL_POSTER),
        },
        ...rungOutputs.flatMap((rung): Rendition[] => {
          const url = publicUrls.get(rung.name);
          const quality = `${rung.height}` as Quality;
          return url
            ? [{ _key: renditionKey(quality), _type: "rendition", quality, url, poster: publicUrls.get(rung.posterName) }]
            : [];
        }),
      ];

      const nextVideo: VideoValue = {
        // Keep the array `_key`, so this stays the same entry of an array field.
        ...(value?._key ? { _key: value._key } : {}),
        _type: config.typeName,
        renditions,
        placeholder: frame.placeholder,
        dimensions: { width: frame.width, height: frame.height },
        // `set` replaces the whole object, so carry the editor's playback over (initial values only apply once).
        ...(config.playback ? { playback: playbackFrom(value) } : {}),
      };

      props.onChange(set(nextVideo));
      setSuccess(
        `Video processed. Renditions: ${renditions.map((r) => r.quality).join(", ")}.${
          skipped.length ? ` Dropped ${skipped.join("; ")}: the larger file serves that size.` : ""
        }`
      );
      setFile(null);
      setProbe(null);

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      setObjectUrl(null);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Unknown upload error.";
      // Last resort: the probe should catch undecodable files, but turn a bare WebCodecs "Decoding error"
      // that slips through into actionable guidance.
      const hint = (await loadMedia().catch(() => undefined))?.REEXPORT_HINT ?? "";
      setError(/decoding error/i.test(raw) ? `Your browser couldn't decode this file. ${hint}`.trim() : raw);
    } finally {
      setStage("idle");
      setProgress(0);
      setStageLabel("");
    }
  };

  // Link a video already in the bucket instead of transcoding a new one.
  const handlePickFromLibrary = async (asset: LibraryAsset) => {
    setApplying(asset.id);
    setError(null);
    setSuccess(null);

    try {
      props.onChange(set(await assetToVideoValue(asset, value, { typeName: config.typeName, playback: config.playback })));
      setSuccess(`Linked "${asset.name}" (${asset.renditions.length} rendition(s)).`);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link this video.");
    } finally {
      setApplying(null);
    }
  };

  return (
    <Stack gap={3}>
      {value ? <CurrentVideoPreview value={value} /> : null}
      <Card border padding={4} radius={2} tone="transparent">
        <Stack gap={4}>
          <Flex align="center" gap={1}>
            <Text size={1}>Video automation</Text>
            <Tooltip
              content={
                <Box padding={3} style={{ maxWidth: 360 }}>
                  <Stack gap={3}>
                    <Text size={1}>
                      Pick a file, choose a poster frame and the resolution ladder, then upload. The browser decodes the poster
                      and transcodes the checked rungs with MediaBunny, then uploads the untouched original, every rung, and each
                      poster straight to storage. Keep the tab open until it finishes.
                    </Text>
                    <Text size={1}>
                      Decoding runs in the browser (WebCodecs), so the source must be a format the browser can decode. Safest:
                      H.264, 8-bit (4:2:0), up to Level 5.1. HEVC/H.265, 10-bit, or very high H.264 levels often won't decode; if
                      so, you'll see a warning here when you pick the file.
                    </Text>
                  </Stack>
                </Box>
              }
              fallbackPlacements={["right", "bottom"]}
              placement="top"
              portal
            >
              <Button aria-label="About video automation" icon={InfoOutlineIcon} mode="bleed" padding={1} />
            </Tooltip>
          </Flex>

          {!hasToken ? (
            <Card border padding={3} radius={2} tone="caution">
              <Text size={1}>Set `auth.loginMethod: "token"` in sanity.config to use video uploads.</Text>
            </Card>
          ) : null}

          {tiersWarning ? (
            <Card border padding={3} radius={2} tone="caution">
              <Text size={1}>{tiersWarning}</Text>
            </Card>
          ) : null}

          <Card border padding={3} radius={2} tone="transparent">
            <Stack gap={3}>
              <Text size={1} muted>
                Maximum file size: {formatMegabytes(config.maxFileSize)}.
              </Text>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                disabled={isBusy || !hasToken}
                onChange={(event) => onSelectFile(event.target.files?.[0] ?? null)}
                style={{ display: "none" }}
              />
              <Flex gap={2}>
                <Button
                  icon={UploadIcon}
                  mode="ghost"
                  text={file ? "Change file" : "Upload a file"}
                  disabled={isBusy || !hasToken}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ flex: 1 }}
                />
                <Button
                  icon={ThLargeIcon}
                  mode="ghost"
                  text="Choose from library"
                  disabled={isBusy || !hasToken}
                  onClick={() => setPickerOpen(true)}
                  style={{ flex: 1 }}
                />
              </Flex>
              <Card border padding={2} radius={2} tone="transparent">
                <Text size={1} muted textOverflow="ellipsis">
                  {file ? `Selected: ${file.name} (${formatMegabytes(file.size)})` : "No file selected."}
                </Text>
              </Card>
              {probe ? <ProbeNotice probe={probe} /> : null}
            </Stack>
          </Card>

          {objectUrl ? (
            <Card border padding={3} radius={2} tone="transparent">
              <Stack gap={3}>
                <video
                  ref={videoRef}
                  src={objectUrl}
                  onLoadedMetadata={onLoadedMetadata}
                  muted
                  playsInline
                  preload="metadata"
                  style={{ width: "100%", maxHeight: 320, borderRadius: 4, background: "#000" }}
                />
                <Stack gap={2}>
                  <Text size={1} muted>
                    Poster frame: {posterTime.toFixed(1)}s of {duration.toFixed(1)}s
                  </Text>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, duration)}
                    step={0.1}
                    value={posterTime}
                    disabled={isBusy || !duration}
                    onChange={(event) => onScrub(Number(event.target.value))}
                    style={{ width: "100%" }}
                  />
                </Stack>
              </Stack>
            </Card>
          ) : null}

          {tiers.length ? (
            <Card border padding={3} radius={2} tone="transparent">
              <Stack gap={3}>
                <Text size={1} weight="semibold">
                  Resolution ladder
                </Text>
                <Flex gap={3} wrap="wrap">
                  {tiers.map((height) => {
                    const tooTall = Boolean(sourceHeight) && height > sourceHeight;
                    return (
                      <Flex key={height} align="center" gap={2}>
                        <Checkbox
                          checked={ladder.includes(height)}
                          disabled={isBusy || tooTall}
                          onChange={() => toggleRung(height)}
                        />
                        <Text size={1} muted={tooTall}>
                          {height}p{tooTall ? " (larger than source)" : ""}
                        </Text>
                      </Flex>
                    );
                  })}
                </Flex>
                <Text size={1} muted>
                  The untouched original is always kept. Only the checked sizes are transcoded, capped at the source resolution.
                  The source audio track is preserved.
                </Text>
              </Stack>
            </Card>
          ) : null}

          <Flex align="center" gap={2}>
            <Button
              text={isBusy ? "Working..." : "Upload & Process"}
              tone="primary"
              disabled={!canUpload}
              onClick={handleUpload}
            />
            {renditionCount > 0 ? (
              <Text size={1} muted>
                Current: {renditionCount} rendition(s)
              </Text>
            ) : null}
          </Flex>

          {isBusy ? (
            <Card border padding={3} radius={2} tone="primary">
              <Stack gap={3}>
                <Flex align="center" gap={3}>
                  <Spinner muted size={1} />
                  <Text size={1}>{stageLabel || "Working..."}</Text>
                </Flex>
                <Box>
                  <progress value={Math.round(progress * 100)} max={100} style={{ width: "100%" }} />
                </Box>
                <Flex align="center" justify="space-between" gap={3}>
                  <Text size={1} muted>
                    {Math.round(progress * 100)}%
                  </Text>
                  <Text size={1} muted>
                    {formatElapsed(elapsedSeconds)} elapsed
                  </Text>
                </Flex>
              </Stack>
            </Card>
          ) : null}

          {error ? (
            <Card border padding={3} radius={2} tone="critical">
              <Text size={1}>{error}</Text>
            </Card>
          ) : null}

          {success ? (
            <Card border padding={3} radius={2} tone="positive">
              <Text size={1}>{success}</Text>
            </Card>
          ) : null}
        </Stack>
      </Card>
      {pickerOpen ? (
        <VideoLibraryPicker onClose={() => setPickerOpen(false)} onSelect={handlePickFromLibrary} busyId={applying} />
      ) : null}
      {props.renderDefault(props)}
    </Stack>
  );
}
