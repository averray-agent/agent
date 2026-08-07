#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDiscoveryManifest,
  POLKADOT_HUB_MAINNET_CHAIN_ID
} from "../../mcp-server/src/core/discovery-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const checkOnly = process.argv.includes("--check");

const committedTargets = [
  "discovery/agent-tools.json",
  "discovery/.well-known/agent-tools.json"
];
const generatedTargets = ["site/.well-known/agent-tools.json"];
const targets = checkOnly ? committedTargets : [...committedTargets, ...generatedTargets];

// The discovery/ copies are the committed production canonical. The site/
// mirror is deploy output: regenerate it on sync, but do not require it to be
// committed. All copies pin mainnet; live API stacks derive from AUTH_CHAIN_ID.
const content = `${JSON.stringify(buildDiscoveryManifest({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID }), null, 2)}\n`;
let drifted = false;

for (const target of targets) {
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
