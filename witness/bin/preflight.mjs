#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runPreflight } from "../src/preflight.mjs";

const USAGE = `Usage:
  witness/bin/preflight.mjs --repo <url|path> --check <command> [--out <file>]

Options:
  --repo <url|path>          Git URL, GitHub owner/repo, or local repository path
  --check <command>         Frozen command to execute at the base revision
  --out <file>              Write the JSON report to a file instead of stdout
  --timeout <seconds>       Per-container timeout (default: 300)
  --image <name>            Pinned local Witness image override
  --protected-path <path>   Candidate-protected path (repeatable)
  --frozen-input <path>     Frozen local replacement for an external input (repeatable)
  --help                    Show this help
`;

export function parseArgs(argv) {
  const result = { frozenInputs: [], protectedPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--repo") result.repo = value;
    else if (arg === "--check") result.check = value;
    else if (arg === "--out") result.out = value;
    else if (arg === "--timeout") result.timeoutSeconds = Number(value);
    else if (arg === "--image") result.image = value;
    else if (arg === "--protected-path") result.protectedPaths.push(value);
    else if (arg === "--frozen-input") result.frozenInputs.push(value);
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  if (!result.repo) throw new Error("--repo is required");
  if (!result.check) throw new Error("--check is required");
  if (result.timeoutSeconds !== undefined && (!Number.isFinite(result.timeoutSeconds) || result.timeoutSeconds <= 0)) {
    throw new Error("--timeout must be a positive number");
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const report = await runPreflight(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const output = resolve(options.out);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json, { flag: "w" });
    console.error(`${report.repo}: ${report.classification} -> ${output}`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
