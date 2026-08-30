/**
 * The backend image copies ./src and a hand-listed set of deployment manifests
 * into /deployments. Code under src resolves those manifests through
 * `../../../deployments/...`, which lands on the repo root in a checkout and on
 * /deployments inside the image — so anything src reads must be COPYed
 * explicitly, and nothing in the build fails when it is not.
 *
 * The inverse matters too: every repository path copied into this image must
 * select a backend rebuild when it changes. The deploy matcher is derived
 * from these COPY sources, and the tests below bind that runtime derivation
 * back to the Dockerfile so a green deploy cannot leave copied code stale.
 *
 * That list has been short twice, both times discovered in production:
 *   1. transparency's native multisig AccountId32 read silently unreadable,
 *      while the EVM lens beside it kept working;
 *   2. the payout-receipt backfill died on ENOENT for deployments/mainnet.json
 *      the first time an operator ran it.
 *
 * Both were invisible to CI because CI runs from a checkout, where the path
 * resolves. This test compares what src actually reads against what the
 * Dockerfile actually carries.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_BACKEND_REBUILD_ALTERNATIVES,
  assertDockerfileCopyCoverage,
  buildBackendRebuildPattern,
  dockerfileCopySources,
} from "./backend-image-rebuild-pattern.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(repoRoot, "mcp-server", "src");
const dockerfile = path.join(repoRoot, "mcp-server", "Dockerfile");
const deployScript = path.join(repoRoot, "scripts", "ops", "deploy-production.sh");

// Profiles a manifest path template can expand to. Kept explicit rather than
// inferred from the deployments directory, so adding an unrelated json file
// there does not silently widen what the image is required to carry.
const PROFILES = ["mainnet", "testnet"];

const LITERAL_MANIFEST = /deployments\/([A-Za-z0-9._-]+\.json)/gu;
// e.g. resolve(repoRoot, "deployments", `${profile}.json`)
const TEMPLATED_MANIFEST = /["']deployments["']\s*,\s*`\$\{[^}]+\}\.json`/u;

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".js") ? [full] : [];
  });
}

function manifestsReadBySource() {
  const required = new Map();
  for (const file of walk(srcRoot)) {
    if (file.endsWith(".test.js")) continue;
    const source = readFileSync(file, "utf8");
    const relative = path.relative(repoRoot, file);
    for (const [, name] of source.matchAll(LITERAL_MANIFEST)) {
      if (!required.has(name)) required.set(name, relative);
    }
    if (TEMPLATED_MANIFEST.test(source)) {
      for (const profile of PROFILES) {
        const name = `${profile}.json`;
        if (!required.has(name)) required.set(name, `${relative} (profile template)`);
      }
    }
  }
  return required;
}

function manifestsCopiedByImage() {
  const copied = new Set();
  for (const line of readFileSync(dockerfile, "utf8").split("\n")) {
    const match = /^\s*COPY\s+deployments\/(\S+)\s/u.exec(line);
    if (match) copied.add(match[1]);
  }
  return copied;
}

test("every deployment manifest read by src is copied into the image", () => {
  const required = manifestsReadBySource();
  const copied = manifestsCopiedByImage();

  assert.ok(required.size > 0, "found no manifest reads in src — the scan is probably broken");

  const missing = [...required.entries()]
    .filter(([name]) => !copied.has(name))
    .map(([name, reader]) => `deployments/${name} (read by ${reader})`);

  assert.deepEqual(
    missing,
    [],
    `mcp-server/Dockerfile does not COPY manifests that src reads at runtime:\n  ${missing.join("\n  ")}\n` +
      "These resolve in a checkout and ENOENT inside the container."
  );
});

test("every manifest the image copies exists in the repo", () => {
  for (const name of manifestsCopiedByImage()) {
    const full = path.join(repoRoot, "deployments", name);
    assert.ok(
      statSync(full).isFile(),
      `mcp-server/Dockerfile copies deployments/${name}, which does not exist — the build would fail.`
    );
  }
});

test("every Dockerfile COPY source is covered by the backend rebuild pattern", () => {
  const dockerfileText = readFileSync(dockerfile, "utf8");
  const rebuildPattern = buildBackendRebuildPattern({ dockerfileText, repoRoot });
  assert.equal(assertDockerfileCopyCoverage({ dockerfileText, rebuildPattern, repoRoot }), true);

  const deploySource = readFileSync(deployScript, "utf8");
  assert.match(
    deploySource,
    /backend_rebuild_pattern=\$\(node[\s\S]*?backend-image-rebuild-pattern\.mjs[\s\S]*?mcp-server\/Dockerfile/u,
    "production deploy must use the Dockerfile-derived matcher that this test checks",
  );
});

test("every Dockerfile-copied scripts ops file triggers a backend rebuild", () => {
  const dockerfileText = readFileSync(dockerfile, "utf8");
  const rebuildPattern = new RegExp(buildBackendRebuildPattern({ dockerfileText, repoRoot }), "u");
  const copiedOpsFiles = dockerfileCopySources(dockerfileText)
    .filter((source) => source.startsWith("scripts/ops/"));

  assert.ok(copiedOpsFiles.length > 0, "Dockerfile exposes no copied scripts/ops files — the scan is probably broken");
  for (const source of copiedOpsFiles) {
    assert.match(source, rebuildPattern, `${source} ships in the backend image and must rebuild it when changed`);
  }
});

test("inverse coverage mutation catches a newly COPYed path missing from a stale matcher", () => {
  const dockerfileText = readFileSync(dockerfile, "utf8");
  const stalePattern = buildBackendRebuildPattern({ dockerfileText, repoRoot });
  const mutatedDockerfile = `${dockerfileText.trimEnd()}\nCOPY scripts/ops/future-money-driver.mjs ./scripts/ops/future-money-driver.mjs\n`;

  assert.throws(
    () => assertDockerfileCopyCoverage({
      dockerfileText: mutatedDockerfile,
      rebuildPattern: stalePattern,
      repoRoot,
    }),
    /scripts\/ops\/future-money-driver\.mjs/u,
  );
});

test("Dockerfile derivation preserves every pre-existing backend trigger", () => {
  const dockerfileText = readFileSync(dockerfile, "utf8");
  const rebuildPattern = new RegExp(buildBackendRebuildPattern({ dockerfileText, repoRoot }), "u");
  const preExistingPaths = [
    "mcp-server/src/server.js",
    "witness/src/executor.mjs",
    "sdk/src/index.js",
    "examples/client.js",
    "docs/schemas/work-receipt-v1.json",
    "package.json",
    "package-lock.json",
    "scripts/ops/redeploy-backend.sh",
    "deploy/witness-docker-proxy/config.json",
    "deploy/mcp-egress-proxy/config.json",
    "deploy/docker-compose.mainnet.yml",
    "deploy/backend.env.template",
    "deploy/backend.mainnet.env.template",
    "deployments/testnet.json",
    "deployments/mainnet.json",
  ];

  assert.equal(LEGACY_BACKEND_REBUILD_ALTERNATIVES.length, 11);
  for (const source of preExistingPaths) {
    assert.match(source, rebuildPattern, `pre-existing backend trigger stopped matching ${source}`);
  }
});
