#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renditions } from "./renditions.ts";

const HELP = `Usage: sanity-video-ladder renditions [options]

Adds missing ladder rungs to every video in the dataset with ffmpeg, or re-encodes them, without
uploading again through the Studio. Reads video-ladder.config.ts (or .mts, .mjs, .js) in the working
directory. Needs ffmpeg and ffprobe on the PATH.

Options:
  --tiers <list>    Comma-separated tiers to process, from the config's tiers (default: all of them)
  --filter <text>   Only videos whose folder key contains this text
  --force           Re-encode tiers the documents already have (new files under new keys)
  --prune           Only remove rungs not smaller than the next larger file (no encoding)
  --dry-run         Print the plan and exit without encoding or writing
  -y, --yes         Skip the confirmation
  --config <path>   The config file to load
  -h, --help        Show this help
  -v, --version     Show the version
`;

function version() {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

let parsed: ReturnType<typeof parse>;

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      tiers: { type: "string" },
      filter: { type: "string" },
      force: { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      config: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
}

try {
  parsed = parse();
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
  process.exit(1);
}

const { values, positionals } = parsed;
const [command] = positionals;

if (values.version) {
  console.log(version());
} else if (values.help || !command) {
  console.log(HELP);
} else if (command === "renditions") {
  await renditions({
    config: values.config,
    tiers: values.tiers,
    filter: values.filter,
    force: values.force,
    prune: values.prune,
    dryRun: values["dry-run"],
    yes: values.yes,
  }).catch((error: unknown) => {
    console.error(`\n❌ Unexpected error.\n   ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}
