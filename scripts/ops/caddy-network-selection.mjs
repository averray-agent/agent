#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { renderCutover, routeState } from "./render-caddy-cutover.mjs";

export const SCHEMA = "averray-caddy-network-selection-v1";
export const NETWORKS = {
  testnet: { expectedChainId: 420420417 },
  mainnet: { expectedChainId: 420420419 },
};

export function resolveDeploymentTarget({ statePath, stackRoot, appRoot } = {}) {
  const record = readSelection(statePath);
  const normalizedStackRoot = requiredString(stackRoot, "deployment stackRoot");
  const normalizedAppRoot = requiredString(appRoot, "deployment appRoot");
  const shared = {
    network: record.network,
    expectedChainId: record.expectedChainId,
  };

  if (record.network === "mainnet") {
    return {
      ...shared,
      composeFile: join(normalizedAppRoot, "deploy/docker-compose.mainnet.yml"),
      // Must be the compose file's own directory: the mainnet compose uses
      // relative build contexts (context: ..) and was brought up by
      // start-mainnet-sidecar.sh WITHOUT --project-directory, i.e. with
      // compose's default (the file's directory). Passing the app root here
      // shifts the build context to /srv/agent-stack/mcp-server (2026-07-27
      // deploy failure). Project identity is unaffected: the file pins
      // name: agent-mainnet.
      projectDirectory: join(normalizedAppRoot, "deploy"),
      backendService: "mainnet-backend",
      backendContainer: "agent-mainnet-backend",
      indexerService: "mainnet-indexer",
      runtimeRoot: "/run/agent-stack-mainnet",
      credentialsRoot: "/etc/agent-stack-mainnet",
      backendTemplate: join(normalizedAppRoot, "deploy/backend.mainnet.env.template"),
      indexerTemplate: join(normalizedAppRoot, "deploy/indexer.mainnet.env.template"),
    };
  }

  return {
    ...shared,
    composeFile: join(normalizedStackRoot, "docker-compose.yml"),
    projectDirectory: normalizedStackRoot,
    backendService: "backend",
    backendContainer: "agent-backend",
    indexerService: "indexer",
    runtimeRoot: "/run/agent-stack",
    credentialsRoot: "/etc/agent-stack",
    backendTemplate: join(normalizedAppRoot, "deploy/backend.env.template"),
    indexerTemplate: join(normalizedAppRoot, "deploy/indexer.env.template"),
  };
}

function requiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

export function validateSelection(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("network selection must be a JSON object");
  }
  if (record.schema !== SCHEMA) {
    throw new Error(`network selection schema must be ${SCHEMA}`);
  }
  if (!Object.hasOwn(NETWORKS, record.network)) {
    throw new Error("network selection must be testnet or mainnet");
  }
  if (record.expectedChainId !== NETWORKS[record.network].expectedChainId) {
    throw new Error(
      `network selection expectedChainId must be ${NETWORKS[record.network].expectedChainId} for ${record.network}`,
    );
  }
  if (record.previousNetwork != null && !Object.hasOwn(NETWORKS, record.previousNetwork)) {
    throw new Error("network selection previousNetwork must be testnet or mainnet");
  }
  for (const field of [
    "selectedAt",
    "selectedBy",
    "executionUser",
    "host",
    "source",
    "sourceRevision",
    "operationId",
    "reason",
  ]) {
    requiredString(record[field], `network selection ${field}`);
  }
  if (!Number.isFinite(Date.parse(record.selectedAt))) {
    throw new Error("network selection selectedAt must be an ISO timestamp");
  }
  if (!/^[0-9a-f]{40}$/u.test(record.sourceRevision)) {
    throw new Error("network selection sourceRevision must be a 40-character lowercase Git SHA");
  }
  return record;
}

export function buildSelection({
  network,
  previousNetwork = network,
  selectedAt = new Date().toISOString(),
  selectedBy,
  executionUser,
  host,
  source,
  sourceRevision,
  operationId,
  reason,
} = {}) {
  return validateSelection({
    schema: SCHEMA,
    network,
    expectedChainId: NETWORKS[network]?.expectedChainId,
    previousNetwork,
    selectedAt,
    selectedBy,
    executionUser,
    host,
    source,
    sourceRevision,
    operationId,
    reason,
  });
}

export function readSelection(path) {
  return validateSelection(JSON.parse(readFileSync(path, "utf8")));
}

export function writeSelectionAtomic(path, record) {
  validateSelection(record);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temporary = join(dir, `.caddy-network-selection.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return record;
}

export function bootstrapSelection({
  statePath,
  liveCaddyPath,
  selectedBy,
  executionUser,
  host,
  sourceRevision,
  operationId,
  selectedAt,
} = {}) {
  if (existsSync(statePath)) {
    return { created: false, record: readSelection(statePath) };
  }
  const liveRoute = routeState(readFileSync(liveCaddyPath, "utf8"));
  if (!(liveRoute in NETWORKS)) {
    throw new Error(`refusing to bootstrap network selection from ${liveRoute} live Caddy routing`);
  }
  const record = buildSelection({
    network: liveRoute,
    previousNetwork: liveRoute,
    selectedAt,
    selectedBy,
    executionUser,
    host,
    source: "deploy-bootstrap-live-route",
    sourceRevision,
    operationId,
    reason: "one-time migration from the validated live Caddy route",
  });
  writeSelectionAtomic(statePath, record);
  return { created: true, record };
}

export function renderSelectedNetwork({ statePath, inputPath, outputPath } = {}) {
  const record = readSelection(statePath);
  const source = readFileSync(inputPath, "utf8");
  const rendered = renderCutover(source, record.network);
  writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
  return {
    network: record.network,
    expectedChainId: record.expectedChainId,
    selectedAt: record.selectedAt,
    selectedBy: record.selectedBy,
    operationId: record.operationId,
    sourceRevision: record.sourceRevision,
    inputRoute: routeState(source),
    outputRoute: routeState(rendered),
    changed: source !== rendered,
  };
}

export function renderTargetNetwork({ network, inputPath, outputPath } = {}) {
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new Error("target network must be testnet or mainnet");
  }
  const source = readFileSync(inputPath, "utf8");
  const current = routeState(source);
  const rendered = renderCutover(source, network);
  writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
  return {
    current,
    target: network,
    changed: source !== rendered,
  };
}

export function selectionStatus({ statePath, liveCaddyPath } = {}) {
  const record = readSelection(statePath);
  const liveRoute = routeState(readFileSync(liveCaddyPath, "utf8"));
  return {
    stateFile: statePath,
    selectedNetwork: record.network,
    expectedChainId: record.expectedChainId,
    liveRoute,
    consistent: liveRoute === record.network,
    selectedAt: record.selectedAt,
    selectedBy: record.selectedBy,
    executionUser: record.executionUser,
    host: record.host,
    source: record.source,
    sourceRevision: record.sourceRevision,
    operationId: record.operationId,
    reason: record.reason,
    previousNetwork: record.previousNetwork,
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = rest[++index];
    if (value == null) throw new Error(`${flag} requires a value`);
    args[key] = value;
  }
  return args;
}

function selectionFromArgs(args) {
  return buildSelection({
    network: args.network,
    previousNetwork: args.previousNetwork ?? args.network,
    selectedAt: args.selectedAt,
    selectedBy: args.selectedBy,
    executionUser: args.executionUser,
    host: args.host,
    source: args.source,
    sourceRevision: args.sourceRevision,
    operationId: args.operationId,
    reason: args.reason,
  });
}

function usage() {
  return `Usage:
  caddy-network-selection.mjs status --state <file> --live-caddy <file>
  caddy-network-selection.mjs deploy-target --state <file> --stack-root <dir> --app-root <dir>
  caddy-network-selection.mjs bootstrap --state <file> --live-caddy <file> --selected-by <actor> --execution-user <user> --host <host> --source-revision <sha> --operation-id <id>
  caddy-network-selection.mjs set --state <file> --network <testnet|mainnet> --previous-network <testnet|mainnet> --selected-at <iso> --selected-by <actor> --execution-user <user> --host <host> --source <source> --source-revision <sha> --operation-id <id> --reason <text>
  caddy-network-selection.mjs render --state <file> --input <Caddyfile> --output <Caddyfile>
  caddy-network-selection.mjs render-target --network <testnet|mainnet> --input <Caddyfile> --output <Caddyfile>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === "status") {
    result = selectionStatus({ statePath: args.state, liveCaddyPath: args.liveCaddy });
  } else if (args.command === "deploy-target") {
    result = resolveDeploymentTarget({
      statePath: args.state,
      stackRoot: args.stackRoot,
      appRoot: args.appRoot,
    });
  } else if (args.command === "bootstrap") {
    result = bootstrapSelection({
      statePath: args.state,
      liveCaddyPath: args.liveCaddy,
      selectedBy: args.selectedBy,
      executionUser: args.executionUser,
      host: args.host,
      sourceRevision: args.sourceRevision,
      operationId: args.operationId,
      selectedAt: args.selectedAt,
    });
  } else if (args.command === "set") {
    result = writeSelectionAtomic(args.state, selectionFromArgs(args));
  } else if (args.command === "render") {
    result = renderSelectedNetwork({
      statePath: args.state,
      inputPath: args.input,
      outputPath: args.output,
    });
  } else if (args.command === "render-target") {
    result = renderTargetNetwork({
      network: args.network,
      inputPath: args.input,
      outputPath: args.output,
    });
  } else {
    throw new Error(usage());
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith("caddy-network-selection.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(1);
  }
}
