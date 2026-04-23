#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateEvidence } from "./validate-native-xcm-evidence.mjs";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const request = options.requestJson ? await readJson(options.requestJson) : {};
const hub = options.hubJson ? await readJson(options.hubJson) : {};
const bifrost = options.bifrostJson ? await readJson(options.bifrostJson) : {};

const requestId = pickString(options.requestId, request.requestId, request.id);
const direction = normalizeDirection(pickString(options.direction, request.direction, request.kindLabel, request.kind));
const status = normalizeStatus(pickString(options.status, request.statusLabel, request.status));
const settledAssets = pickString(options.settledAssets, request.settledAssets, bifrost.settledAssets, bifrost.amount, "0");
const settledShares = pickString(options.settledShares, request.settledShares, bifrost.settledShares, "0");
const remoteRef = pickString(options.remoteRef, request.remoteRef, bifrost.remoteRef, bifrost.extrinsicHash, bifrost.blockHash);
const failureCode = pickString(options.failureCode, request.failureCode);
const observedAt = pickString(options.observedAt, bifrost.observedAt, hub.observedAt, new Date().toISOString());

if (!requestId) fail("requestId is required. Pass --request-id or provide it in --request-json.");
if (!options.hubJson) fail("--hub-json is required.");
if (!options.bifrostJson) fail("--bifrost-json is required.");

const evidence = {
  schemaVersion: "native-xcm-observer-evidence-v1",
  requestId,
  direction,
  status,
  settledAssets,
  settledShares,
  remoteRef: remoteRef || null,
  failureCode: failureCode || null,
  observedAt,
  correlation: {
    method: normalizeCorrelationMethod(options.method ?? "remote_ref"),
    confidence: normalizeConfidence(options.confidence ?? "staging"),
    notes: options.notes ?? "Captured with scripts/ops/capture-native-xcm-evidence.mjs."
  },
  hub: normalizeHubEvidence(hub),
  bifrost: normalizeBifrostEvidence(bifrost),
  decision: {
    status,
    settledAssets,
    settledShares,
    remoteRef: remoteRef || null,
    failureCode: failureCode || null,
    observedAt,
    reason: options.reason ?? defaultReason(status)
  }
};

validateEvidence(evidence);

const outputPath = options.output ?? process.env.XCM_NATIVE_EVIDENCE_PATH;
if (!outputPath) {
  console.log(JSON.stringify(evidence, null, 2));
} else {
  const absoluteOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Saved native XCM evidence to ${absoluteOutputPath}`);
}

console.log(`Native XCM evidence captured for ${requestId} (${direction}, ${status}).`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
      parsed[key] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/capture-native-xcm-evidence.mjs [options]

Required:
  --request-id <0x...>         Averray request id, unless present in --request-json.
  --hub-json <path>            Hub-side replay/PAPI evidence JSON.
  --bifrost-json <path>        Bifrost-side replay/PAPI evidence JSON.

Common options:
  --request-json <path>        Existing /xcm/request JSON or exercise report fragment.
  --direction <deposit|withdraw|claim>
  --status <succeeded|failed|cancelled>
  --settled-assets <integer>
  --settled-shares <integer>
  --remote-ref <0x...>
  --failure-code <0x...>
  --observed-at <iso-date>
  --method <request_id_in_message|remote_ref|ledger_join>
  --confidence <staging|production_candidate|production>
  --notes <text>
  --reason <text>
  --output <path>              Write evidence JSON. Prints to stdout if omitted.
  --help
`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

function normalizeHubEvidence(value) {
  return {
    chain: pickString(value.chain, "polkadot-hub"),
    blockNumber: requireString(pickString(value.blockNumber, value.block_number), "hub.blockNumber"),
    blockHash: requireString(pickString(value.blockHash, value.block_hash), "hub.blockHash"),
    extrinsicHash: pickString(value.extrinsicHash, value.extrinsic_hash, value.txHash, value.transactionHash),
    messageHash: pickString(value.messageHash, value.message_hash),
    eventIndex: requireString(pickString(value.eventIndex, value.event_index, value.index), "hub.eventIndex")
  };
}

function normalizeBifrostEvidence(value) {
  return {
    chain: pickString(value.chain, "bifrost-polkadot"),
    blockNumber: requireString(pickString(value.blockNumber, value.block_number), "bifrost.blockNumber"),
    blockHash: requireString(pickString(value.blockHash, value.block_hash), "bifrost.blockHash"),
    eventIndex: requireString(pickString(value.eventIndex, value.event_index, value.index), "bifrost.eventIndex"),
    assetLocation: value.assetLocation ?? value.asset_location ?? null,
    amount: pickString(value.amount, value.settledAssets, "0")
  };
}

function pickString(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    return String(value).trim();
  }
  return "";
}

function requireString(value, label) {
  if (!value) fail(`${label} is required.`);
  return value;
}

function normalizeDirection(value) {
  const normalized = String(value || "deposit").trim().toLowerCase();
  if (normalized === "0") return "deposit";
  if (normalized === "1") return "withdraw";
  if (normalized === "2") return "claim";
  if (["deposit", "withdraw", "claim"].includes(normalized)) return normalized;
  fail(`direction must be deposit, withdraw, or claim; got ${JSON.stringify(value)}.`);
}

function normalizeStatus(value) {
  const normalized = String(value || "succeeded").trim().toLowerCase();
  if (["succeeded", "failed", "cancelled"].includes(normalized)) return normalized;
  fail(`status must be succeeded, failed, or cancelled; got ${JSON.stringify(value)}.`);
}

function normalizeCorrelationMethod(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["request_id_in_message", "remote_ref", "ledger_join"].includes(normalized)) return normalized;
  fail(`correlation method must be request_id_in_message, remote_ref, or ledger_join; got ${JSON.stringify(value)}.`);
}

function normalizeConfidence(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["staging", "production_candidate", "production"].includes(normalized)) return normalized;
  fail(`confidence must be staging, production_candidate, or production; got ${JSON.stringify(value)}.`);
}

function defaultReason(status) {
  if (status === "failed") return "matched_terminal_failure_event";
  if (status === "cancelled") return "matched_terminal_cancelled_event";
  return "matched_terminal_bifrost_event";
}

function fail(message) {
  throw new Error(message);
}
