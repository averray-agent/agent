#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = "incident-response-proof-v1";

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;
const EMAIL_OR_ALIAS_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const REQUIRED_POLKADOT_DOCS = [
  "smart-contracts/explorers.md",
  "smart-contracts/for-eth-devs/accounts.md"
];
const EXPLORER_HOSTS = new Set([
  "blockscout.polkadot.io",
  "blockscout-testnet.polkadot.io",
  "polkadot.routescan.io",
  "polkadot.testnet.routescan.io",
  "assethub-polkadot.subscan.io",
  "assethub-paseo.subscan.io"
]);
const MAINNET_EXPLORER_HOSTS = new Set([
  "blockscout.polkadot.io",
  "polkadot.routescan.io",
  "assethub-polkadot.subscan.io"
]);
const ROLLBACK_COMPONENTS = [
  ["backend", "scripts/ops/redeploy-backend.sh"],
  ["indexer", "scripts/ops/redeploy-indexer.sh"],
  ["frontend", "scripts/ops/redeploy-frontend.sh"]
];
const SAFE_HEX_PATH_PATTERN = /(blockHash|callHash|contentHash|evidenceHash|explorerUrl|explorerUrls\[\d+\]|proofHash|receiptHash|reasoningHash|transactionHash|txHash|pauseTxHash|unpauseTxHash)$/iu;

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/incident-response-YYYY-MM-DD.json [--json] [--max-completed-age-hours N] [--require-mainnet]

Validates a redacted incident-response rehearsal proof artifact. This check is
offline and read-only: it does not call RPC, send alerts, pause contracts, or
roll back services.

The evidence file must use schema ${SCHEMA_VERSION}. Use
--max-completed-age-hours when validating launch evidence so stale rehearsal
artifacts cannot be reused. Add --require-mainnet before closing the mainnet
incident-response launch row.
`;
}

export function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    maxCompletedAgeHours: undefined,
    requireMainnet: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--max-completed-age-hours") {
      args.maxCompletedAgeHours = parsePositiveNumber(argv[index + 1], "--max-completed-age-hours");
      index += 1;
    } else if (arg === "--require-mainnet") {
      args.requireMainnet = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (!args.file && !arg.startsWith("-")) {
      args.file = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePositiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return number;
}

function assertObject(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function requireString(value, path, errors, { pattern = undefined } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  const trimmed = value.trim();
  if (pattern && !pattern.test(trimmed)) {
    errors.push(`${path} has an invalid format`);
  }
  return trimmed;
}

function requireBoolean(value, path, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${path} must be boolean`);
    return undefined;
  }
  return value;
}

function requireNumber(value, path, errors, { integer = false, min = undefined, max = undefined } = {}) {
  const ok = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!ok) {
    errors.push(`${path} must be ${integer ? "an integer" : "a finite number"}`);
    return undefined;
  }
  if (min !== undefined && value < min) {
    errors.push(`${path} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    errors.push(`${path} must be <= ${max}`);
  }
  return value;
}

function requireIsoDate(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    errors.push(`${path} must be an ISO-8601 date/time`);
  }
  return raw;
}

function requireDateOnly(value, path, errors) {
  return requireString(value, path, errors, { pattern: /^\d{4}-\d{2}-\d{2}$/u });
}

function requireIsoTimestamp(value, path, errors) {
  const raw = requireIsoDate(value, path, errors);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function requireHash(value, path, errors) {
  return requireString(value, path, errors, { pattern: HASH_PATTERN });
}

function requireHttpUrl(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push(`${path} must be an http(s) URL`);
    }
  } catch {
    errors.push(`${path} must be an http(s) URL`);
  }
  return raw;
}

function requireExplorerUrl(value, path, errors, { requireMainnet = false } = {}) {
  const raw = requireHttpUrl(value, path, errors);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!EXPLORER_HOSTS.has(parsed.hostname)) {
      errors.push(`${path} must use a Polkadot Hub or Hub TestNet explorer host`);
    } else if (requireMainnet && !MAINNET_EXPLORER_HOSTS.has(parsed.hostname)) {
      errors.push(`${path} must use a Polkadot Hub mainnet explorer host when --require-mainnet is used`);
    }
  } catch {
    // requireHttpUrl already reported this.
  }
  return raw;
}

function assertNotAfterCompletedAt(value, path, completedAt, errors) {
  if (!Number.isFinite(value) || !Number.isFinite(completedAt)) return;
  if (value > completedAt + FUTURE_SKEW_MS) {
    errors.push(`${path} must not be later than completedAt`);
  }
}

function validateFreshness(completedAt, options, errors) {
  if (options.maxCompletedAgeHours === undefined) return;
  if (!Number.isFinite(options.maxCompletedAgeHours) || options.maxCompletedAgeHours <= 0) {
    errors.push("maxCompletedAgeHours must be a positive number");
    return;
  }
  if (!Number.isFinite(completedAt)) return;

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    errors.push("now must be a valid Date or timestamp");
    return;
  }
  if (completedAt > nowMs + FUTURE_SKEW_MS) {
    errors.push("completedAt must not be in the future");
  }
  const maxAgeMs = options.maxCompletedAgeHours * 60 * 60 * 1000;
  if (nowMs - completedAt > maxAgeMs) {
    errors.push(`completedAt must be within ${options.maxCompletedAgeHours} hour(s)`);
  }
}

function containsSecretLikeValue(value, path) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (/^(sha256|blake2):[a-fA-F0-9]{32,128}$/u.test(trimmed)) {
    return false;
  }
  const safeHexPath = SAFE_HEX_PATH_PATTERN.test(path);
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bASIA[0-9A-Z]{16}\b/u,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /\bre_[A-Za-z0-9_]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+-]+/u
  ];
  if (!safeHexPath && /\b0x[a-fA-F0-9]{64}\b/u.test(trimmed)) {
    return true;
  }
  return patterns.some((pattern) => pattern.test(trimmed));
}

function scanForSecretLikeValues(value, path, errors) {
  if (containsSecretLikeValue(value, path)) {
    errors.push(`${path} appears to contain a secret value; store raw secrets outside this evidence file`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForSecretLikeValues(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanForSecretLikeValues(entry, `${path}.${key}`, errors);
    }
  }
}

function validatePolkadotDocs(rawDocs, errors) {
  const docs = requireArray(rawDocs, "polkadotDocs", errors);
  for (const requiredPath of REQUIRED_POLKADOT_DOCS) {
    if (!docs.includes(requiredPath)) {
      errors.push(`polkadotDocs must include ${requiredPath}`);
    }
  }
}

function validateTarget(rawTarget, options, errors) {
  const target = assertObject(rawTarget, "target", errors);
  const environment = requireString(target.environment, "target.environment", errors);
  if (environment && environment !== "production") {
    errors.push("target.environment must be production");
  }
  const apiBaseUrl = requireHttpUrl(target.apiBaseUrl, "target.apiBaseUrl", errors);
  if (apiBaseUrl && !/^https:\/\/api\.averray\.com\/?$/u.test(apiBaseUrl)) {
    errors.push("target.apiBaseUrl must be the hosted production API base URL");
  }
  const chainEnv = requireString(target.chainEnv, "target.chainEnv", errors);
  if (!["testnet", "mainnet"].includes(chainEnv)) {
    errors.push("target.chainEnv must be testnet or mainnet");
  }
  const network = requireString(target.network, "target.network", errors);
  if (!["polkadot-hub-testnet", "polkadot-hub-mainnet"].includes(network)) {
    errors.push("target.network must be polkadot-hub-testnet or polkadot-hub-mainnet");
  }
  if (chainEnv === "testnet" && network !== "polkadot-hub-testnet") {
    errors.push("target.network must be polkadot-hub-testnet when target.chainEnv is testnet");
  }
  if (chainEnv === "mainnet" && network !== "polkadot-hub-mainnet") {
    errors.push("target.network must be polkadot-hub-mainnet when target.chainEnv is mainnet");
  }
  if (options.requireMainnet) {
    if (chainEnv !== "mainnet") {
      errors.push("target.chainEnv must be mainnet when --require-mainnet is used");
    }
    if (network !== "polkadot-hub-mainnet") {
      errors.push("target.network must be polkadot-hub-mainnet when --require-mainnet is used");
    }
  }
  return { chainEnv, network };
}

function validateContacts(rawContacts, errors) {
  const contacts = assertObject(rawContacts, "contacts", errors);
  requireString(contacts.primaryOnCall, "contacts.primaryOnCall", errors, { pattern: EMAIL_OR_ALIAS_PATTERN });
  requireString(contacts.backupOnCall, "contacts.backupOnCall", errors, { pattern: EMAIL_OR_ALIAS_PATTERN });
  requireString(contacts.pauserOperator, "contacts.pauserOperator", errors, { pattern: EMAIL_OR_ALIAS_PATTERN });
  const escalation = assertObject(contacts.externalEscalation, "contacts.externalEscalation", errors);
  const status = requireString(escalation.status, "contacts.externalEscalation.status", errors);
  if (!["engaged", "not_engaged_v1"].includes(status)) {
    errors.push("contacts.externalEscalation.status must be engaged or not_engaged_v1");
  }
  if (status === "engaged") {
    requireString(escalation.provider, "contacts.externalEscalation.provider", errors);
    requireString(escalation.contact, "contacts.externalEscalation.contact", errors);
  } else if (status === "not_engaged_v1") {
    if (requireBoolean(escalation.internalFallbackDocumented, "contacts.externalEscalation.internalFallbackDocumented", errors) !== true) {
      errors.push("contacts.externalEscalation.internalFallbackDocumented must be true when no external retainer is engaged");
    }
  }
}

function validateSeverityDrills(rawDrills, errors) {
  const drills = assertObject(rawDrills, "severityDrills", errors);

  const p1 = assertObject(drills.p1, "severityDrills.p1", errors);
  if (requireBoolean(p1.acknowledged, "severityDrills.p1.acknowledged", errors) !== true) {
    errors.push("severityDrills.p1.acknowledged must be true");
  }
  requireNumber(p1.ackMinutes, "severityDrills.p1.ackMinutes", errors, { min: 0, max: 5 });
  if (requireBoolean(p1.humanOwnerEngaged, "severityDrills.p1.humanOwnerEngaged", errors) !== true) {
    errors.push("severityDrills.p1.humanOwnerEngaged must be true");
  }
  if (requireBoolean(p1.pauseDecisionRecorded, "severityDrills.p1.pauseDecisionRecorded", errors) !== true) {
    errors.push("severityDrills.p1.pauseDecisionRecorded must be true");
  }

  const p2 = assertObject(drills.p2, "severityDrills.p2", errors);
  if (requireBoolean(p2.acknowledged, "severityDrills.p2.acknowledged", errors) !== true) {
    errors.push("severityDrills.p2.acknowledged must be true");
  }
  requireNumber(p2.ackMinutes, "severityDrills.p2.ackMinutes", errors, { min: 0, max: 15 });
  requireNumber(p2.mitigationOrRollbackMinutes, "severityDrills.p2.mitigationOrRollbackMinutes", errors, { min: 0, max: 60 });

  const p3 = assertObject(drills.p3, "severityDrills.p3", errors);
  if (requireBoolean(p3.sameDayTriage, "severityDrills.p3.sameDayTriage", errors) !== true) {
    errors.push("severityDrills.p3.sameDayTriage must be true");
  }
}

function validateAlertDelivery(rawAlert, completedAt, errors) {
  const alert = assertObject(rawAlert, "alertDelivery", errors);
  if (requireBoolean(alert.checkHostedStackAndAlertRan, "alertDelivery.checkHostedStackAndAlertRan", errors) !== true) {
    errors.push("alertDelivery.checkHostedStackAndAlertRan must be true");
  }
  if (requireBoolean(alert.deliberateFailureDelivered, "alertDelivery.deliberateFailureDelivered", errors) !== true) {
    errors.push("alertDelivery.deliberateFailureDelivered must be true");
  }
  if (requireBoolean(alert.greenAfterRestore, "alertDelivery.greenAfterRestore", errors) !== true) {
    errors.push("alertDelivery.greenAfterRestore must be true");
  }
  if (requireBoolean(alert.webhookSecretRedacted, "alertDelivery.webhookSecretRedacted", errors) !== true) {
    errors.push("alertDelivery.webhookSecretRedacted must be true");
  }
  requireString(alert.channel, "alertDelivery.channel", errors);
  requireString(alert.correlationId, "alertDelivery.correlationId", errors);
  const receivedAt = requireIsoTimestamp(alert.receivedAt, "alertDelivery.receivedAt", errors);
  assertNotAfterCompletedAt(receivedAt, "alertDelivery.receivedAt", completedAt, errors);
}

function validatePauseFlow(rawPause, options, errors) {
  const pause = assertObject(rawPause, "pauseFlow", errors);
  requireString(pause.evidenceFile, "pauseFlow.evidenceFile", errors);
  if (requireBoolean(pause.pauserEvidenceValidated, "pauseFlow.pauserEvidenceValidated", errors) !== true) {
    errors.push("pauseFlow.pauserEvidenceValidated must be true");
  }
  const command = requireString(pause.validationCommand, "pauseFlow.validationCommand", errors);
  if (!command.includes("check-pauser-rehearsal-evidence.mjs")) {
    errors.push("pauseFlow.validationCommand must use check-pauser-rehearsal-evidence.mjs");
  }
  if (requireBoolean(pause.livePauseUnpauseRehearsed, "pauseFlow.livePauseUnpauseRehearsed", errors) !== true) {
    errors.push("pauseFlow.livePauseUnpauseRehearsed must be true");
  }
  if (requireBoolean(pause.pausedStateObserved, "pauseFlow.pausedStateObserved", errors) !== true) {
    errors.push("pauseFlow.pausedStateObserved must be true");
  }
  if (requireBoolean(pause.unpausedStateObserved, "pauseFlow.unpausedStateObserved", errors) !== true) {
    errors.push("pauseFlow.unpausedStateObserved must be true");
  }
  if (pause.finalPaused !== false) {
    errors.push("pauseFlow.finalPaused must be false");
  }
  requireHash(pause.pauseTxHash, "pauseFlow.pauseTxHash", errors);
  requireHash(pause.unpauseTxHash, "pauseFlow.unpauseTxHash", errors);
  const explorerUrls = requireArray(pause.explorerUrls, "pauseFlow.explorerUrls", errors);
  if (explorerUrls.length < 2) {
    errors.push("pauseFlow.explorerUrls must include pause and unpause explorer URLs");
  }
  explorerUrls.forEach((url, index) => requireExplorerUrl(url, `pauseFlow.explorerUrls[${index}]`, errors, {
    requireMainnet: options.requireMainnet === true
  }));
  if (options.requireMainnet && command && !command.includes("--require-dedicated-pauser")) {
    errors.push("pauseFlow.validationCommand must include --require-dedicated-pauser when --require-mainnet is used");
  }
}

function validateRollback(rawRollback, completedAt, errors) {
  const rollback = assertObject(rawRollback, "rollbackRehearsal", errors);
  for (const [component, script] of ROLLBACK_COMPONENTS) {
    const path = `rollbackRehearsal.${component}`;
    const entry = assertObject(rollback[component], path, errors);
    const entryScript = requireString(entry.script, `${path}.script`, errors);
    if (entryScript !== script) {
      errors.push(`${path}.script must be ${script}`);
    }
    if (requireBoolean(entry.rollbackPathExercised, `${path}.rollbackPathExercised`, errors) !== true) {
      errors.push(`${path}.rollbackPathExercised must be true`);
    }
    if (requireBoolean(entry.healthGateObserved, `${path}.healthGateObserved`, errors) !== true) {
      errors.push(`${path}.healthGateObserved must be true`);
    }
    if (component !== "frontend" && requireBoolean(entry.envRerenderObserved, `${path}.envRerenderObserved`, errors) !== true) {
      errors.push(`${path}.envRerenderObserved must be true`);
    }
    requireString(entry.correlationId, `${path}.correlationId`, errors);
    const completed = requireIsoTimestamp(entry.completedAt, `${path}.completedAt`, errors);
    assertNotAfterCompletedAt(completed, `${path}.completedAt`, completedAt, errors);
  }
}

function validateEscalation(rawEscalation, errors) {
  const escalation = assertObject(rawEscalation, "escalation", errors);
  requireString(escalation.incidentChannel, "escalation.incidentChannel", errors);
  if (requireBoolean(escalation.primaryAck, "escalation.primaryAck", errors) !== true) {
    errors.push("escalation.primaryAck must be true");
  }
  if (requireBoolean(escalation.backupAck, "escalation.backupAck", errors) !== true) {
    errors.push("escalation.backupAck must be true");
  }
  if (requireBoolean(escalation.ownerSignerReachable, "escalation.ownerSignerReachable", errors) !== true) {
    errors.push("escalation.ownerSignerReachable must be true");
  }
  if (requireBoolean(escalation.handoffRecordCreated, "escalation.handoffRecordCreated", errors) !== true) {
    errors.push("escalation.handoffRecordCreated must be true");
  }
  requireString(escalation.handoffRecord, "escalation.handoffRecord", errors);
}

function validatePostIncidentRecord(rawRecord, errors) {
  const record = assertObject(rawRecord, "postIncidentRecord", errors);
  requireString(record.recordUri, "postIncidentRecord.recordUri", errors);
  const requiredTrue = [
    "containsTimeline",
    "containsBlastRadius",
    "containsRootCause",
    "containsDetectionReview",
    "containsPreventionChange",
    "containsResumeCriteria",
    "noSecrets"
  ];
  for (const field of requiredTrue) {
    if (requireBoolean(record[field], `postIncidentRecord.${field}`, errors) !== true) {
      errors.push(`postIncidentRecord.${field} must be true`);
    }
  }
}

function validateGuardrails(rawGuardrails, errors) {
  const guardrails = assertObject(rawGuardrails, "guardrails", errors);
  const requiredTrue = [
    "noPrivateKeys",
    "noRawWebhooks",
    "noJwt",
    "noProviderApiKeys",
    "productionChangesReverted"
  ];
  for (const field of requiredTrue) {
    if (requireBoolean(guardrails[field], `guardrails.${field}`, errors) !== true) {
      errors.push(`guardrails.${field} must be true`);
    }
  }
  if (guardrails.directFundsMovementClaimed !== false) {
    errors.push("guardrails.directFundsMovementClaimed must be false");
  }
  if (guardrails.finalPaused !== false) {
    errors.push("guardrails.finalPaused must be false");
  }
}

export function validateEvidence(evidence, options = {}) {
  const errors = [];
  const warnings = [];
  const doc = assertObject(evidence, "evidence", errors);

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const proofDate = requireDateOnly(doc.proofDate, "proofDate", errors);
  const completedAt = requireIsoTimestamp(doc.completedAt, "completedAt", errors);
  if (proofDate && Number.isFinite(completedAt)) {
    const completedDate = new Date(completedAt).toISOString().slice(0, 10);
    if (proofDate !== completedDate) {
      errors.push("proofDate must match completedAt UTC date");
    }
  }
  validateFreshness(completedAt, options, errors);

  validatePolkadotDocs(doc.polkadotDocs, errors);
  const target = validateTarget(doc.target, options, errors);
  validateContacts(doc.contacts, errors);
  validateSeverityDrills(doc.severityDrills, errors);
  validateAlertDelivery(doc.alertDelivery, completedAt, errors);
  validatePauseFlow(doc.pauseFlow, options, errors);
  validateRollback(doc.rollbackRehearsal, completedAt, errors);
  validateEscalation(doc.escalation, errors);
  validatePostIncidentRecord(doc.postIncidentRecord, errors);
  validateGuardrails(doc.guardrails, errors);
  scanForSecretLikeValues(doc, "evidence", errors);

  if (options.maxCompletedAgeHours === undefined) {
    warnings.push("completedAt freshness was not enforced; use --max-completed-age-hours for launch evidence");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      proofDate: doc.proofDate,
      completedAt: doc.completedAt,
      chainEnv: target.chainEnv,
      network: target.network,
      alertDelivered: doc.alertDelivery?.deliberateFailureDelivered === true,
      pauseRehearsed: doc.pauseFlow?.livePauseUnpauseRehearsed === true,
      finalPaused: doc.pauseFlow?.finalPaused,
      rollbackComponents: ROLLBACK_COMPONENTS.map(([component]) => component),
      mainnetRequired: options.requireMainnet === true,
      freshnessEnforced: Number.isFinite(options.maxCompletedAgeHours)
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.file) {
    throw new Error("--file is required");
  }

  const raw = await readFile(args.file, "utf8");
  const parsed = JSON.parse(raw);
  const result = validateEvidence(parsed, {
    maxCompletedAgeHours: args.maxCompletedAgeHours,
    requireMainnet: args.requireMainnet
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      warnings: result.warnings,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Incident response proof evidence ok: ${args.file}\n`);
    for (const warning of result.warnings) {
      process.stderr.write(`- warning: ${warning}\n`);
    }
  } else {
    process.stderr.write(`Incident response proof evidence invalid: ${args.file}\n`);
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
