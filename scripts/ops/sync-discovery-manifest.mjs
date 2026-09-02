#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDiscoveryManifest } from "../../mcp-server/src/core/discovery-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const checkOnly = process.argv.includes("--check");

const targets = [
  "discovery/agent-tools.json",
  "discovery/.well-known/agent-tools.json",
  "site/.well-known/agent-tools.json"
];

const content = `${JSON.stringify(buildDiscoveryManifest(), null, 2)}\n`;
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
