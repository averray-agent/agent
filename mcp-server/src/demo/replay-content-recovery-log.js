import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replayContentRecoveryLog } from "../core/content-recovery-log.js";
import { createStateStore } from "../core/state-store.js";
import { loadLocalEnv } from "../services/env-loader.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(process.cwd(), resolve(moduleDir, "../../"));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stateStore = createStateStore(process.env, { logger: console });
  const summary = await replayContentRecoveryLog({
    dir: options.dir ?? process.env.CONTENT_RECOVERY_LOG_DIR,
    stateStore,
    apply: options.apply,
    logger: console
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.invalid > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = { apply: false, dir: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--dir") {
      if (!args[index + 1]) {
        throw new Error("--dir requires a path.");
      }
      options.dir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
      if (!options.dir) {
        throw new Error("--dir requires a path.");
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm --workspace mcp-server run replay:content-recovery -- [--apply] [--dir PATH]

Replays append-only content recovery JSONL files into the configured state store.
Dry-run is the default. Pass --apply to write records.
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
