import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  type VideoCodec,
} from "mediabunny";

// The MediaBunny (WebCodecs) pipeline, run entirely in the browser: probe a picked file, decode its
// poster, transcode each H.264/MP4 ladder rung. Because WebCodecs can't decode every codec/profile,
// `probeFile` dry-runs the real transcode up front so the UI can reject unsupported files with guidance
// instead of failing mid-upload. The untouched original is uploaded as-is (never re-encoded). The input
// loads this module with `import()` when an editor picks a file, so MediaBunny stays out of the Studio's
// initial bundle.

export type Probe =
  | { state: "checking" }
  | { state: "ok"; summary: string }
  | { state: "unsupported"; summary: string; reason: string };

export const REEXPORT_HINT =
  "Re-export it as H.264 (not HEVC/H.265), 8-bit, at a lower H.264 level. The level comes down when you reduce the resolution or frame rate, or turn off hardware ('Boost') encoding. Then pick it again.";

// Poster box, aspect preserved.
const POSTER_MAX_WIDTH = 1920;
const POSTER_MAX_HEIGHT = 1080;
const PROBE_HEIGHT = 240;
// Constant quality (H.264 quantizer, like CRF): a bitrate target starves screen recordings, whose source
// averages a low bitrate, and turns text into blocks. The bitrate is only the fallback for browsers whose
// encoder cannot do quantizer mode, and is never derived from the source.
const RUNG_QUANTIZER = 20;
const FALLBACK_BITS_PER_PIXEL_SECOND = 4;

function toEven(value: number) {
  const floored = Math.floor(value);
  return floored % 2 === 0 ? floored : floored - 1;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode the poster image."))), type, quality);
  });
}

let audioEncoderReady = false;

// Register an AAC encoder when the browser lacks one natively, so source audio survives the transcode.
async function ensureAudioEncoder() {
  if (audioEncoderReady) {
    return;
  }

  if (!(await canEncodeAudio("aac"))) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
  }

  audioEncoderReady = true;
}

/** Confirm H.264 encoding is available and ready the AAC encoder; returns the codec for `transcodeRung`. */
export async function prepareEncoder(): Promise<VideoCodec> {
  const codec = await getFirstEncodableVideoCodec(["avc"]);

  if (!codec) {
    throw new Error("This browser can't encode H.264 video. Use a recent Chrome, Edge, Firefox or Safari.");
  }

  await ensureAudioEncoder();
  return codec;
}

/** Selected rungs capped at the source height (never upscaled). A source below every rung yields none: the
 *  original is always uploaded anyway. */
export function computeLadder(sourceHeight: number, selected: number[]): number[] {
  const source = toEven(sourceHeight);
  return Array.from(new Set(selected.map(toEven)))
    .filter((h) => h > 0 && h <= source)
    .sort((a, b) => b - a);
}

/** Encoding quality for a rung: quantizer-driven when the browser supports it, else a generous bitrate. */
export function rungQuality(rungHeight: number, srcWidth: number, srcHeight: number) {
  const rungWidth = Math.round((srcWidth / srcHeight) * rungHeight);
  const fallbackBitrate = Math.round(rungWidth * rungHeight * FALLBACK_BITS_PER_PIXEL_SECOND);
  return new Quality({ quantizer: RUNG_QUANTIZER, bitrate: fallbackBitrate, bitrateMode: "variable" });
}

/** Dry-run the real pipeline on a ~0.3s slice. WebCodecs `canDecode()` and even a one-frame decode are
 *  optimistic: a file can pass them yet still throw "Decoding error" once the actual `Conversion` runs,
 *  so only running the exact decode + encode path the upload uses catches unsupported files reliably. */
export async function probeFile(file: File): Promise<Probe> {
  let summary = file.name;
  let sourceHeight = 0;
  let duration = 0;

  const metaInput = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  try {
    const track = await metaInput.getPrimaryVideoTrack();

    if (!track) {
      return { state: "unsupported", summary, reason: "No video track was found in this file." };
    }

    const codec = await track.getCodec();
    const params = await track.getCodecParameterString();
    const width = await track.getDisplayWidth();
    sourceHeight = await track.getDisplayHeight();
    duration = await metaInput.computeDuration();
    const codecLabel = codec ? `${codec.toUpperCase()}${params ? ` (${params})` : ""}` : "unknown codec";
    summary = `${codecLabel}, ${width}x${sourceHeight}, ${duration.toFixed(1)}s`;
  } catch (error) {
    return { state: "unsupported", summary, reason: error instanceof Error ? error.message : "This file could not be read." };
  } finally {
    metaInput.dispose();
  }

  const encodable = await getFirstEncodableVideoCodec(["avc"]);

  if (!encodable) {
    return {
      state: "unsupported",
      summary,
      reason: "This browser can't encode H.264 video. Use a recent Chrome, Edge, Firefox or Safari.",
    };
  }

  await ensureAudioEncoder();

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      video: { height: Math.min(PROBE_HEIGHT, toEven(sourceHeight) || PROBE_HEIGHT), codec: encodable, bitrate: 300_000 },
      trim: { start: 0, end: Math.min(0.3, Math.max(0.05, duration)) },
    });

    const droppedVideo = conversion.discardedTracks.find((track) => track.track.isVideoTrack());

    if (droppedVideo) {
      return {
        state: "unsupported",
        summary,
        reason: `Your browser can't decode this file's video (${droppedVideo.reason}). ${REEXPORT_HINT}`,
      };
    }

    const droppedAudio = conversion.discardedTracks.find((track) => track.track.isAudioTrack());

    if (droppedAudio) {
      return {
        state: "unsupported",
        summary,
        reason: `Your browser can't keep this file's audio track (${droppedAudio.reason}). Re-export it with AAC audio (or no audio), then pick it again.`,
      };
    }

    await conversion.execute();

    if (!output.target.buffer) {
      throw new Error("no output");
    }

    return { state: "ok", summary };
  } catch {
    return { state: "unsupported", summary, reason: `Your browser can't transcode this file. ${REEXPORT_HINT}` };
  } finally {
    input.dispose();
  }
}

/** Decode one frame at `timeSec` into a detached canvas (capped to 1920x1080, aspect preserved) plus a
 *  ~24px base64 WebP blur placeholder (resolution-independent, one per video), with the source's display
 *  dimensions and duration. Encode per-rendition posters from the returned canvas with `encodePosterWebp`. */
export async function decodePosterFrame(props: { file: File; timeSec: number }) {
  const input = new Input({ source: new BlobSource(props.file), formats: ALL_FORMATS });

  try {
    const track = await input.getPrimaryVideoTrack();

    if (!track) {
      throw new Error("No video track found in this file.");
    }

    const srcWidth = await track.getDisplayWidth();
    const srcHeight = await track.getDisplayHeight();
    const duration = await input.computeDuration();
    const time = Math.min(Math.max(0, props.timeSec), Math.max(0, duration - 0.001));

    const scale = Math.min(1, POSTER_MAX_WIDTH / srcWidth, POSTER_MAX_HEIGHT / srcHeight);
    const targetWidth = Math.max(2, toEven(srcWidth * scale));

    const sink = new CanvasSink(track, { width: targetWidth, fit: "fill" });
    const wrapped = (await sink.getCanvas(time)) ?? (await sink.getCanvas(0));

    if (!wrapped) {
      throw new Error("Could not extract a poster frame from this file.");
    }

    const frame = wrapped.canvas;
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create a canvas context for the poster.");
    }

    context.drawImage(frame, 0, 0);

    // ~24px base64 WebP LQIP, the blur painted on the site (one per video, resolution-independent).
    const lqipWidth = 24;
    const lqipHeight = Math.max(1, Math.round((frame.height / frame.width) * lqipWidth));
    const lqipCanvas = document.createElement("canvas");
    lqipCanvas.width = lqipWidth;
    lqipCanvas.height = lqipHeight;
    lqipCanvas.getContext("2d")?.drawImage(frame, 0, 0, lqipWidth, lqipHeight);
    const placeholder = lqipCanvas.toDataURL("image/webp", 0.4);

    return { canvas, width: srcWidth, height: srcHeight, duration, placeholder };
  } finally {
    // Close the decoder so repeated uploads don't exhaust the browser's WebCodecs decoder pool.
    input.dispose();
  }
}

/** Encode the decoded poster frame to a WebP, optionally downscaled to `targetHeight` (never upscaled), so
 *  each rendition gets its own correctly-sized poster from the same picked frame. */
export async function encodePosterWebp(canvas: HTMLCanvasElement, targetHeight?: number): Promise<Blob> {
  if (!targetHeight || targetHeight >= canvas.height) {
    return canvasToBlob(canvas, "image/webp", 0.8);
  }

  const scale = targetHeight / canvas.height;
  const out = document.createElement("canvas");
  out.width = Math.max(2, toEven(canvas.width * scale));
  out.height = Math.max(2, toEven(canvas.height * scale));
  out.getContext("2d")?.drawImage(canvas, 0, 0, out.width, out.height);
  return canvasToBlob(out, "image/webp", 0.8);
}

/** Transcode one ladder rung to an H.264/MP4 blob scaled to `height` at the quality from `rungQuality`.
 *  Source audio is preserved (copied when already AAC, else transcoded). Pass the codec from `prepareEncoder`. */
export async function transcodeRung(props: {
  file: File;
  height: number;
  codec: VideoCodec;
  quality: Quality;
  onProgress: (fraction: number) => void;
}): Promise<Blob> {
  const input = new Input({ source: new BlobSource(props.file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      video: { height: props.height, codec: props.codec, quality: props.quality },
      // No `audio` option: Conversion keeps the source track (copies AAC, else transcodes to AAC).
    });

    // Fail loudly rather than silently ship a video that lost its audio track.
    const droppedAudio = conversion.discardedTracks.find((track) => track.track.isAudioTrack());

    if (droppedAudio) {
      throw new Error(`Could not preserve the source audio track (${droppedAudio.reason}).`);
    }

    conversion.onProgress = (fraction) => props.onProgress(fraction);
    await conversion.execute();

    const buffer = output.target.buffer;

    if (!buffer) {
      throw new Error(`The ${props.height}p transcode produced no output.`);
    }

    return new Blob([buffer], { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}
