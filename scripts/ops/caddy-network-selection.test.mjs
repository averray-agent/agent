import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as networkSelection from "./caddy-network-selection.mjs";
import {
  SCHEMA,
  bootstrapSelection,
  buildSelection,
  readSelection,
  renderSelectedNetwork,
  renderTargetNetwork,
  selectionStatus,
  validateSelection,
  writeSelectionAtomic,
} from "./caddy-network-selection.mjs";

const TESTNET_CADDY = `api.averray.com {
  reverse_proxy backend:8787
}
index.averray.com {
  reverse_proxy indexer:42069
}
`;

function selection(network, overrides = {}) {
  return buildSelection({
    network,
    previousNetwork: network,
    selectedAt: "2026-07-27T10:00:00.000Z",
    selectedBy: "pascal-via-codex",
    executionUser: "root",
    host: "prod.invalid",
    source: "flip-caddy-network.sh",
    sourceRevision: "b".repeat(40),
    operationId: `cutover-${network}-1`,
    reason: `guarded cutover to ${network}`,
    ...overrides,
  });
}

test("selection record answers which network, when, who, where, and from which revision", () => {
  const record = selection("mainnet", { previousNetwork: "testnet" });
  assert.equal(record.schema, SCHEMA);
  assert.equal(record.network, "mainnet");
  assert.equal(record.expectedChainId, 420420419);
  assert.equal(record.previousNetwork, "testnet");
  assert.equal(record.selectedBy, "pascal-via-codex");
  assert.equal(record.executionUser, "root");
  assert.equal(record.host, "prod.invalid");
  assert.equal(record.sourceRevision, "b".repeat(40));
  assert.equal(record.operationId, "cutover-mainnet-1");
});

test("selection validation rejects an inconsistent chain ID and incomplete audit metadata", () => {
  assert.throws(
    () => validateSelection({ ...selection("mainnet"), expectedChainId: 420420417 }),
    /expectedChainId must be 420420419/u,
  );
  assert.throws(
    () => validateSelection({ ...selection("mainnet"), selectedBy: "" }),
    /selectedBy must be a non-empty string/u,
  );
});

test("atomic write replaces the record and leaves a readable 0644 audit file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-selection-write-"));
  const state = join(dir, "selection.json");
  writeSelectionAtomic(state, selection("testnet"));
  writeSelectionAtomic(state, selection("mainnet", { previousNetwork: "testnet" }));
  assert.equal(readSelection(state).network, "mainnet");
  assert.equal((await stat(state)).mode & 0o777, 0o644);
});

test("one-time bootstrap records the existing pure live route and never overwrites it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-selection-bootstrap-"));
  const state = join(dir, "selection.json");
  const live = join(dir, "Caddyfile");
  await writeFile(live, TESTNET_CADDY);
  const first = bootstrapSelection({
    statePath: state,
    liveCaddyPath: live,
    selectedBy: "github-actions:depre-dev",
    executionUser: "ubuntu",
    host: "prod.invalid",
    sourceRevision: "c".repeat(40),
    operationId: "deploy-bootstrap-1",
    selectedAt: "2026-07-27T10:00:00.000Z",
  });
  assert.equal(first.created, true);
  assert.equal(first.record.network, "testnet");

  await writeFile(live, TESTNET_CADDY.replaceAll("backend:8787", "mainnet-backend:8787")
    .replaceAll("indexer:42069", "mainnet-indexer:42069"));
  const second = bootstrapSelection({
    statePath: state,
    liveCaddyPath: live,
    selectedBy: "must-not-overwrite",
    executionUser: "ubuntu",
    host: "prod.invalid",
    sourceRevision: "d".repeat(40),
    operationId: "deploy-bootstrap-2",
  });
  assert.equal(second.created, false);
  assert.equal(second.record.network, "testnet");
});

test("normal render persists mainnet across the repository's testnet template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-selection-render-"));
  const state = join(dir, "selection.json");
  const template = join(dir, "template");
  const rendered = join(dir, "rendered");
  const live = join(dir, "Caddyfile");
  await writeFile(template, TESTNET_CADDY);
  writeSelectionAtomic(state, selection("mainnet", { previousNetwork: "testnet" }));

  const result = renderSelectedNetwork({ statePath: state, inputPath: template, outputPath: rendered });
  await writeFile(live, await readFile(rendered));

  assert.equal(result.inputRoute, "testnet");
  assert.equal(result.outputRoute, "mainnet");
  assert.match(await readFile(live, "utf8"), /mainnet-backend:8787/u);
  assert.equal(selectionStatus({ statePath: state, liveCaddyPath: live }).consistent, true);
});

test("changing the durable selector to testnet keeps rollback one render operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-selection-rollback-"));
  const state = join(dir, "selection.json");
  const template = join(dir, "template");
  const live = join(dir, "Caddyfile");
  await writeFile(template, TESTNET_CADDY);
  writeSelectionAtomic(state, selection("testnet", { previousNetwork: "mainnet" }));

  renderSelectedNetwork({ statePath: state, inputPath: template, outputPath: live });

  assert.match(await readFile(live, "utf8"), /reverse_proxy backend:8787/u);
  assert.doesNotMatch(await readFile(live, "utf8"), /mainnet-backend/u);
  assert.equal(selectionStatus({ statePath: state, liveCaddyPath: live }).consistent, true);
});

test("guarded flip rendering is available through the host-node fallback tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-selection-target-"));
  const input = join(dir, "input");
  const output = join(dir, "output");
  await writeFile(input, TESTNET_CADDY);

  const result = renderTargetNetwork({ network: "mainnet", inputPath: input, outputPath: output });

  assert.equal(result.current, "testnet");
  assert.equal(result.target, "mainnet");
  assert.equal(result.changed, true);
  assert.match(await readFile(output, "utf8"), /mainnet-backend:8787/u);
});

test("durable selection resolves the deploy compose and services in both directions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caddy-selection-deploy-target-"));
  const state = join(dir, "selection.json");
  const stackRoot = join(dir, "stack");
  const appRoot = join(stackRoot, "app");

  writeSelectionAtomic(state, selection("mainnet", { previousNetwork: "testnet" }));
  assert.deepEqual(
    networkSelection.resolveDeploymentTarget({ statePath: state, stackRoot, appRoot }),
    {
      network: "mainnet",
      expectedChainId: 420420419,
      composeFile: join(appRoot, "deploy/docker-compose.mainnet.yml"),
      projectDirectory: appRoot,
      backendService: "mainnet-backend",
      backendContainer: "agent-mainnet-backend",
      indexerService: "mainnet-indexer",
      runtimeRoot: "/run/agent-stack-mainnet",
      credentialsRoot: "/etc/agent-stack-mainnet",
      backendTemplate: join(appRoot, "deploy/backend.mainnet.env.template"),
      indexerTemplate: join(appRoot, "deploy/indexer.mainnet.env.template"),
    },
  );

  writeSelectionAtomic(state, selection("testnet", { previousNetwork: "mainnet" }));
  assert.deepEqual(
    networkSelection.resolveDeploymentTarget({ statePath: state, stackRoot, appRoot }),
    {
      network: "testnet",
      expectedChainId: 420420417,
      composeFile: join(stackRoot, "docker-compose.yml"),
      projectDirectory: stackRoot,
      backendService: "backend",
      backendContainer: "agent-backend",
      indexerService: "indexer",
      runtimeRoot: "/run/agent-stack",
      credentialsRoot: "/etc/agent-stack",
      backendTemplate: join(appRoot, "deploy/backend.env.template"),
      indexerTemplate: join(appRoot, "deploy/indexer.env.template"),
    },
  );
});
