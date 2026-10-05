// The command's console: a header, steps, one summary block, one confirmation, and the same cancel and
// failure exits every time. Nothing here decides anything.

import { createInterface } from "node:readline/promises";

/** One line of the summary block. A row without a label renders as a plain bullet. */
export type SummaryRow = { label?: string; value: string };

/** Opening banner: `{icon}  {title}` followed by indented description lines. */
export function printHeader(icon: string, title: string, lines: string[] = []): void {
  console.log(`\n${icon}  ${title}\n`);

  for (const line of lines) {
    console.log(`   ${line}`);
  }

  if (lines.length > 0) {
    console.log("");
  }
}

/** Renders summary rows with the value column aligned. */
export function formatSummaryRows(rows: SummaryRow[]): string[] {
  const width = rows.reduce((max, row) => Math.max(max, row.label ? row.label.length + 1 : 0), 0);
  return rows.map((row) => (row.label ? `   • ${`${row.label}:`.padEnd(width)} ${row.value}` : `   • ${row.value}`));
}

export function printSummary(rows: SummaryRow[]): void {
  console.log("\n📋 Summary\n");

  for (const line of formatSummaryRows(rows)) {
    console.log(line);
  }

  console.log("");
}

/** Announces a step that is about to run. */
export function printStep(icon: string, message: string): void {
  console.log(`\n${icon} ${message}`);
}

export function printDryRunNotice(): void {
  console.log("🔍 Dry run (--dry-run): the plan is printed, nothing runs and nothing is written.\n");
}

export function finishDryRun(): never {
  console.log("✅ Dry run complete. Nothing changed.\n");
  process.exit(0);
}

export function printDone(message: string, detail?: string): void {
  console.log(`\n✅ ${message}`);

  if (detail) {
    console.log(`   ${detail}`);
  }

  console.log("");
}

/** Exits 0: the user declined or aborted, so nothing happened and this is not an error. */
export function cancel(detail?: string): never {
  console.log("\n👋 Cancelled.");

  if (detail) {
    console.log(`   ${detail}`);
  }

  console.log("");
  process.exit(0);
}

/** Exits 1 with one headline, then indented detail lines. */
export function fail(message: string, ...details: string[]): never {
  console.error(`\n❌ ${message}`);

  for (const detail of details) {
    console.error(`   ${detail}`);
  }

  console.error("");
  process.exit(1);
}

/** The one confirmation before anything is written. Defaults to no, since the command writes to a real
 *  dataset and bucket; Ctrl-C, an empty answer or anything but yes cancels. */
export async function confirmOrCancel(message: string): Promise<void> {
  if (!process.stdin.isTTY) {
    fail("Confirmation needed, but there is no terminal to ask in.", "Pass --yes to run without asking.");
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.on("SIGINT", () => {
    readline.close();
    cancel();
  });

  try {
    const answer = (await readline.question(`❓ ${message} (y/N) `)).trim().toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      cancel();
    }
  } finally {
    readline.close();
  }
}
