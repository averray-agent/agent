import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildProductionDiscoveryManifestContent,
  PRODUCTION_DISCOVERY_BASE_URL
} from "./discovery-manifest-file.mjs";

const SCRIPT = resolve("scripts/ops/sync-discovery-manifest.mjs");
const TARGETS = [
  "discovery/agent-tools.json",
  "discovery/.well-known/agent-tools.json",
  "site/.well-known/agent-tools.json"
];

test("production discovery content pins the live API base URL", () => {
  const manifest = JSON.parse(buildProductionDiscoveryManifestContent());

  assert.equal(manifest.baseUrl, PRODUCTION_DISCOVERY_BASE_URL);
  assert.equal(manifest.protocolEndpoints.http, PRODUCTION_DISCOVERY_BASE_URL);
  assert.equal(manifest.protocolEndpoints.mcp, `${PRODUCTION_DISCOVERY_BASE_URL}/mcp`);
  assert.deepEqual(manifest.protocols, ["http", "mcp"]);
});

test("sync writes and checks every committed discovery mirror", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "discovery-manifest-sync-"));
  for (const target of TARGETS) {
    mkdirSync(join(repoRoot, target, ".."), { recursive: true });
  }

  const sync = runSync(repoRoot);
  assert.equal(sync.status, 0, sync.stderr);
  const expected = buildProductionDiscoveryManifestContent();
  for (const target of TARGETS) {
    assert.equal(readFileSync(join(repoRoot, target), "utf8"), expected, target);
  }

  const check = runSync(repoRoot, "--check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Discovery manifests are in sync/u);
});

test("check fails when the committed public-site mirror drifts", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "discovery-manifest-drift-"));
  for (const target of TARGETS) {
    mkdirSync(join(repoRoot, target, ".."), { recursive: true });
    writeFileSync(join(repoRoot, target), buildProductionDiscoveryManifestContent());
  }
  writeFileSync(
    join(repoRoot, "site/.well-known/agent-tools.json"),
    '{"protocols":["http"]}\n'
  );

  const check = runSync(repoRoot, "--check");

  assert.equal(check.status, 1);
  assert.match(check.stderr, /site\/\.well-known\/agent-tools\.json is not in sync/u);
});

function runSync(repoRoot, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, "--repo-root", repoRoot], {
    encoding: "utf8"
  });
}
