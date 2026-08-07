#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProductionDiscoveryManifestContent } from "./discovery-manifest-file.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, "../..");
const { checkOnly, repoRoot } = parseArgs(process.argv.slice(2));

const committedTargets = [
  "discovery/agent-tools.json",
  "discovery/.well-known/agent-tools.json",
  "site/.well-known/agent-tools.json"
];

// All committed copies are production mirrors of the same function the API
// serves. Pin the baked files to the production base URL and mainnet; live API
// stacks still derive their chain from AUTH_CHAIN_ID.
const content = buildProductionDiscoveryManifestContent();
let drifted = false;

for (const target of committedTargets) {
  const file = path.join(repoRoot, target);
  const current = await readFile(file, "utf8").catch(() => "");
  if (current === content) {
    continue;
  }
  drifted = true;
  if (checkOnly) {
    console.error(`${target} is not in sync with buildDiscoveryManifest().`);
    continue;
  }
  await writeFile(file, content);
  console.log(`Synced ${target}`);
}

if (checkOnly && drifted) {
  process.exitCode = 1;
} else if (checkOnly) {
  console.log("Discovery manifests are in sync.");
}

function parseArgs(args) {
  let checkOnly = false;
  let repoRoot = defaultRepoRoot;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      checkOnly = true;
      continue;
    }
    if (arg === "--repo-root") {
      const value = args[index + 1];
      if (!value) throw new Error("--repo-root requires a path.");
      repoRoot = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { checkOnly, repoRoot };
}
