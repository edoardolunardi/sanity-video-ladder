import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs a command for its output; ffmpeg's error log can be long, so the buffer is generous. */
export function run(command: string, args: string[]) {
  return execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
}

/** Whether both binaries answer, so the command can stop up front with a clear message. */
export async function hasFfmpeg() {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export type Probe = { width: number; height: number; audioCodec?: string };

/** The display size of the first video stream and the codec of the first audio stream, if any. */
export async function probe(input: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height",
    "-of",
    "json",
    input,
  ]);
  const parsed = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
  const video = parsed.streams.find((stream) => stream.codec_type === "video");

  if (!video?.width || !video.height) {
    throw new Error("no video stream");
  }

  return {
    width: video.width,
    height: video.height,
    audioCodec: parsed.streams.find((stream) => stream.codec_type === "audio")?.codec_name,
  };
}
