#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (isMain()) {
  await main();
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const evidencePath = options.file ?? process.env.XCM_NATIVE_EVIDENCE_PATH;
  if (!evidencePath) {
    fail("missing evidence file. Pass --file <path> or set XCM_NATIVE_EVIDENCE_PATH.");
  }

  const absolutePath = path.resolve(evidencePath);
  const evidence = JSON.parse(await readFile(absolutePath, "utf8"));
  const outcome = validateEvidence(evidence);

  console.log("Native XCM evidence validated.");
  console.log(`File: ${absolutePath}`);
  console.log(`Request: ${outcome.requestId}`);
  console.log(`Status: ${outcome.status}`);
  console.log(`Remote ref: ${outcome.remoteRef ?? "none"}`);
  console.log(`Correlation: ${evidence.correlation?.method ?? "unspecified"} (${evidence.correlation?.confidence ?? "unspecified"})`);
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--file") {
      parsed.file = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/validate-native-xcm-evidence.mjs --file <path>

Validates a captured native Polkadot/Bifrost XCM observer evidence envelope.

Options:
  --file <path>  Evidence JSON file to validate.
  --help         Show this help.

Environment:
  XCM_NATIVE_EVIDENCE_PATH
`);
}

export function validateEvidence(value) {
  assertObject(value, "evidence");
  assertEqual(value.schemaVersion, "native-xcm-observer-evidence-v1", "schemaVersion");
  assertHex32(value.requestId, "requestId");
  assertOneOf(value.direction, ["deposit", "withdraw", "claim"], "direction");
  const status = assertOneOf(normalizeString(value.status), ["succeeded", "failed", "cancelled"], "status");
  const settledAssets = assertNonNegativeIntegerString(value.settledAssets ?? value.decision?.settledAssets ?? "0", "settledAssets");
  const settledShares = assertNonNegativeIntegerString(value.settledShares ?? value.decision?.settledShares ?? "0", "settledShares");
  const remoteRef = assertOptionalHex32(value.remoteRef ?? value.decision?.remoteRef, "remoteRef");
  const failureCode = assertOptionalHex32(value.failureCode ?? value.decision?.failureCode, "failureCode");
  const observedAt = assertIsoDate(value.observedAt ?? value.decision?.observedAt, "observedAt");

  assertObject(value.correlation, "correlation");
  const correlationMethod = assertOneOf(value.correlation.method, ["request_id_in_message", "remote_ref", "ledger_join"], "correlation.method");
  const correlationConfidence = assertOneOf(value.correlation.confidence, ["staging", "production_candidate", "production"], "correlation.confidence");

  assertObject(value.hub, "hub");
  assertChainEvidence(value.hub, "hub");

  assertObject(value.bifrost, "bifrost");
  assertChainEvidence(value.bifrost, "bifrost");

  assertObject(value.decision, "decision");
  assertOneOf(normalizeString(value.decision.status), ["succeeded", "failed", "cancelled"], "decision.status");
  if (normalizeString(value.decision.status) !== status) {
    fail("decision.status must match top-level status.");
  }
  if (assertNonNegativeIntegerString(value.decision.settledAssets ?? settledAssets, "decision.settledAssets") !== settledAssets) {
    fail("decision.settledAssets must match top-level settledAssets.");
  }
  if (assertNonNegativeIntegerString(value.decision.settledShares ?? settledShares, "decision.settledShares") !== settledShares) {
    fail("decision.settledShares must match top-level settledShares.");
  }

  if (status === "failed" && !failureCode) {
    fail("failed evidence must include a failureCode.");
  }
  if (status === "succeeded" && !remoteRef) {
    fail("succeeded evidence must include a remoteRef.");
  }
  validateCorrelationGate({
    method: correlationMethod,
    confidence: correlationConfidence,
    requestId: value.requestId,
    remoteRef,
    hub: value.hub,
    bifrost: value.bifrost
  });

  return {
    requestId: value.requestId,
    status,
    settledAssets,
    settledShares,
    remoteRef,
    failureCode,
    observedAt
  };
}

function validateCorrelationGate({ method, confidence, requestId, remoteRef, hub, bifrost }) {
  if (method === "request_id_in_message") {
    assertTopicMatchesRequest(hub, requestId, "hub");
    if (confidence !== "staging") {
      assertTopicMatchesRequest(bifrost, requestId, "bifrost");
    }
    return;
  }
  if (method === "remote_ref") {
    if (!remoteRef) {
      fail("remote_ref correlation requires remoteRef.");
    }
    return;
  }
  if (confidence !== "staging") {
    fail("ledger_join correlation is staging-only and cannot be production_candidate or production.");
  }
}

function assertChainEvidence(value, label) {
  assertString(value.chain, `${label}.chain`);
  assertNonNegativeIntegerString(value.blockNumber, `${label}.blockNumber`);
  assertHex32(value.blockHash, `${label}.blockHash`);
  if (value.extrinsicHash !== undefined) assertHex32(value.extrinsicHash, `${label}.extrinsicHash`);
  if (value.messageHash !== undefined) assertHex32(value.messageHash, `${label}.messageHash`);
  if (value.messageTopic !== undefined) assertHex32(value.messageTopic, `${label}.messageTopic`);
  if (value.message_topic !== undefined) assertHex32(value.message_topic, `${label}.message_topic`);
  if (value.topic !== undefined) assertHex32(value.topic, `${label}.topic`);
  if (value.setTopic !== undefined) assertHex32(value.setTopic, `${label}.setTopic`);
  if (value.set_topic !== undefined) assertHex32(value.set_topic, `${label}.set_topic`);
  assertString(value.eventIndex, `${label}.eventIndex`);
}

function assertTopicMatchesRequest(value, requestId, label) {
  const topic = pickTopic(value);
  if (!topic) {
    fail(`${label} evidence must include messageTopic/topic for request_id_in_message correlation.`);
  }
  if (topic.toLowerCase() !== requestId.toLowerCase()) {
    fail(`${label} message topic must equal requestId.`);
  }
}

function pickTopic(value) {
  for (const key of ["messageTopic", "message_topic", "topic", "setTopic", "set_topic"]) {
    const topic = value?.[key];
    if (topic !== undefined && topic !== null && topic !== "") {
      return assertHex32(topic, key);
    }
  }
  return null;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}.`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeString(value) {
  return String(value ?? "").trim().toLowerCase();
}

function assertOneOf(value, allowed, label) {
  const normalized = normalizeString(value);
  if (!allowed.includes(normalized)) {
    fail(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return normalized;
}

function assertHex32(value, label) {
  const normalized = assertString(value, label);
  if (!/^0x[a-fA-F0-9]{64}$/u.test(normalized)) {
    fail(`${label} must be a 0x-prefixed 32-byte hex string.`);
  }
  return normalized;
}

function assertOptionalHex32(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return assertHex32(value, label);
}

function assertNonNegativeIntegerString(value, label) {
  const normalized = assertString(String(value ?? ""), label);
  if (!/^\d+$/u.test(normalized)) {
    fail(`${label} must be a non-negative integer string.`);
  }
  return normalized;
}

function assertIsoDate(value, label) {
  const normalized = assertString(value, label);
  if (Number.isNaN(new Date(normalized).getTime())) {
    fail(`${label} must be an ISO-8601 date string.`);
  }
  return new Date(normalized).toISOString();
}

function fail(message) {
  throw new Error(message);
}
