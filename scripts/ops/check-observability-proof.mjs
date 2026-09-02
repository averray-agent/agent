#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = "observability-proof-v1";
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/observability-YYYY-MM-DD.json [--json] [--max-completed-age-hours N] [--now <iso>]

Validates the operator evidence for the RC1 observability gates:
metrics bearer auth, hosted alert delivery, and Sentry/logging posture.
This check is read-only; it does not call the hosted stack or alert vendors.

Use --max-completed-age-hours when validating live launch evidence so stale
historical artifacts cannot be reused as current production proof.
Use --now <iso> to pin the freshness comparison clock (defaults to the wall
clock); the value must be an ISO-8601 date/time.
`;
}

function parseIsoNow(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(raw.trim())) {
    throw new Error("--now must be an ISO-8601 date/time");
  }
  const date = new Date(raw.trim());
  if (!Number.isFinite(date.getTime())) {
    throw new Error("--now must be an ISO-8601 date/time");
  }
  return date;
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    maxCompletedAgeHours: undefined,
    now: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--max-completed-age-hours") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--max-completed-age-hours must be a positive number");
      }
      args.maxCompletedAgeHours = value;
      index += 1;
    } else if (arg === "--now") {
      args.now = parseIsoNow(argv[index + 1]);
      index += 1;
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

function assertObject(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireString(value, path, errors, { pattern = undefined, forbidden = undefined } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  const trimmed = value.trim();
  if (pattern && !pattern.test(trimmed)) {
    errors.push(`${path} has an invalid format`);
  }
  if (forbidden && forbidden.test(trimmed)) {
    errors.push(`${path} must not contain secret-looking material`);
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

function requireNumber(value, path, errors, { integer = false, min = undefined } = {}) {
  const ok = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!ok) {
    errors.push(`${path} must be ${integer ? "an integer" : "a finite number"}`);
    return undefined;
  }
  if (min !== undefined && value < min) {
    errors.push(`${path} must be >= ${min}`);
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

function assertNotAfterCompletedAt(value, path, completedAt, errors) {
  if (!Number.isFinite(value) || !Number.isFinite(completedAt)) return;
  if (value > completedAt + FUTURE_SKEW_MS) {
    errors.push(`${path} must not be later than completedAt`);
  }
}

function validateFreshness(completedAt, options, errors) {
  const maxCompletedAgeHours = options.maxCompletedAgeHours;
  if (maxCompletedAgeHours === undefined) return;
  if (!Number.isFinite(maxCompletedAgeHours) || maxCompletedAgeHours <= 0) {
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
  const maxAgeMs = maxCompletedAgeHours * 60 * 60 * 1000;
  if (nowMs - completedAt > maxAgeMs) {
    errors.push(`completedAt must be within ${maxCompletedAgeHours} hour(s)`);
  }
}

function validateEvidence(evidence, options = {}) {
  const errors = [];
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

  const operator = assertObject(doc.operator, "operator", errors);
  requireString(operator.name, "operator.name", errors);
  requireString(operator.signature, "operator.signature", errors);

  const target = assertObject(doc.target, "target", errors);
  const environment = requireString(target.environment, "target.environment", errors);
  if (environment && environment !== "production") {
    errors.push("target.environment must be production");
  }
  const apiBaseUrl = requireHttpUrl(target.apiBaseUrl, "target.apiBaseUrl", errors);
  if (apiBaseUrl && !/^https:\/\/api\.averray\.com\/?$/u.test(apiBaseUrl)) {
    errors.push("target.apiBaseUrl must be the hosted production API base URL");
  }

  const metrics = assertObject(doc.metricsAuth, "metricsAuth", errors);
  if (requireBoolean(metrics.checkHostedStackRan, "metricsAuth.checkHostedStackRan", errors) !== true) {
    errors.push("metricsAuth.checkHostedStackRan must be true");
  }
  const metricsCommand = requireString(metrics.command, "metricsAuth.command", errors);
  if (!metricsCommand.includes("CHECK_METRICS_AUTH=1")) {
    errors.push("metricsAuth.command must include CHECK_METRICS_AUTH=1");
  }
  if (!metricsCommand.includes("METRICS_BEARER_TOKEN")) {
    errors.push("metricsAuth.command must reference METRICS_BEARER_TOKEN without including the token value");
  }
  if (/METRICS_BEARER_TOKEN=(?!\$|'<|"<|<)[^\s]+/u.test(metricsCommand)) {
    errors.push("metricsAuth.command must not include the raw metrics token");
  }
  requireNumber(metrics.unauthenticatedStatus, "metricsAuth.unauthenticatedStatus", errors, { integer: true });
  if (metrics.unauthenticatedStatus !== 401) {
    errors.push("metricsAuth.unauthenticatedStatus must be 401");
  }
  requireNumber(metrics.authenticatedStatus, "metricsAuth.authenticatedStatus", errors, { integer: true });
  if (metrics.authenticatedStatus !== 200) {
    errors.push("metricsAuth.authenticatedStatus must be 200");
  }
  const metricsObservedAt = requireIsoTimestamp(metrics.observedAt, "metricsAuth.observedAt", errors);
  assertNotAfterCompletedAt(metricsObservedAt, "metricsAuth.observedAt", completedAt, errors);

  const alert = assertObject(doc.alertDestination, "alertDestination", errors);
  if (requireBoolean(alert.webhookConfigured, "alertDestination.webhookConfigured", errors) !== true) {
    errors.push("alertDestination.webhookConfigured must be true");
  }
  if (requireBoolean(alert.deliberateFailureDelivered, "alertDestination.deliberateFailureDelivered", errors) !== true) {
    errors.push("alertDestination.deliberateFailureDelivered must be true");
  }
  requireString(alert.channel, "alertDestination.channel", errors);
  requireString(alert.messageId, "alertDestination.messageId", errors);
  const alertReceivedAt = requireIsoTimestamp(alert.receivedAt, "alertDestination.receivedAt", errors);
  assertNotAfterCompletedAt(alertReceivedAt, "alertDestination.receivedAt", completedAt, errors);
  requireString(alert.failureMode, "alertDestination.failureMode", errors);

  const logging = assertObject(doc.sentryLogging, "sentryLogging", errors);
  const decision = requireString(logging.decision, "sentryLogging.decision", errors);
  if (!["sentry_enabled", "log_only_deferred"].includes(decision)) {
    errors.push("sentryLogging.decision must be sentry_enabled or log_only_deferred");
  }
  if (requireBoolean(logging.structuredLogsVisible, "sentryLogging.structuredLogsVisible", errors) !== true) {
    errors.push("sentryLogging.structuredLogsVisible must be true");
  }
  requireString(logging.logSurface, "sentryLogging.logSurface", errors);
  requireString(logging.observedLogLine, "sentryLogging.observedLogLine", errors, {
    forbidden: /(Bearer\s+[-._~+/A-Za-z0-9]+=*|gho_[A-Za-z0-9_]+|re_[A-Za-z0-9_-]{12,}|https:\/\/[^@\s]+@sentry)/iu
  });
  const loggingObservedAt = requireIsoTimestamp(logging.observedAt, "sentryLogging.observedAt", errors);
  assertNotAfterCompletedAt(loggingObservedAt, "sentryLogging.observedAt", completedAt, errors);
  if (decision === "sentry_enabled") {
    if (requireBoolean(logging.sentryReadyObserved, "sentryLogging.sentryReadyObserved", errors) !== true) {
      errors.push("sentryLogging.sentryReadyObserved must be true when Sentry is enabled");
    }
    requireString(logging.sentryProject, "sentryLogging.sentryProject", errors);
  }
  if (decision === "log_only_deferred") {
    if (logging.sentryReadyObserved === true) {
      errors.push("sentryLogging.sentryReadyObserved must not be true when Sentry is deferred");
    }
    requireString(logging.deferredReason, "sentryLogging.deferredReason", errors);
  }

  const secretScanInput = JSON.stringify(doc);
  if (/(Bearer\s+[-._~+/A-Za-z0-9]+=*|gho_[A-Za-z0-9_]+|re_[A-Za-z0-9_-]{12,}|https:\/\/[^@\s]+@sentry)/iu.test(secretScanInput)) {
    errors.push("evidence must not include bearer tokens, provider API keys, or Sentry DSNs");
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      proofDate: doc.proofDate,
      environment: target.environment,
      metrics: {
        unauthenticatedStatus: metrics.unauthenticatedStatus,
        authenticatedStatus: metrics.authenticatedStatus
      },
      alertDelivered: alert.deliberateFailureDelivered === true,
      sentryLoggingDecision: logging.decision,
      operator: operator.name
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
    now: args.now
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Observability proof evidence ok: ${args.file}\n`);
  } else {
    process.stderr.write(`Observability proof evidence invalid: ${args.file}\n`);
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

export {
  SCHEMA_VERSION,
  validateEvidence
};
