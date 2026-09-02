#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = "kms-cloudwatch-alarm-proof-v1";
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const REQUIRED_CLOUDTRAIL_EVENT_NAMES = [
  "Sign",
  "GetPublicKey",
  "DescribeKey",
  "Encrypt",
  "Decrypt"
];

const REQUIRED_ALARM_KINDS = new Map([
  ["blockchain_kms_sign_error", "blockchain signer kms:Sign error alarm"],
  ["jwt_kms_sign_error", "JWT signer kms:Sign error alarm"],
  ["blockchain_kms_access_denied", "blockchain signer KMS AccessDenied alarm"],
  ["jwt_kms_access_denied", "JWT signer KMS AccessDenied alarm"],
  ["blockchain_kms_sign_spike", "blockchain signer kms:Sign spike alarm"],
  ["jwt_kms_sign_spike", "JWT signer kms:Sign spike alarm"],
  ["auth_failure_spike", "auth failure spike alarm"],
  ["auth_refresh_replay_detected", "refresh replay detection alarm"]
]);

const REQUIRED_METRICS = [
  "BlockchainKMSSignCallCount",
  "JwtKMSSignCallCount",
  "BlockchainKMSSignErrorCount",
  "JwtKMSSignErrorCount",
  "BlockchainKMSAccessDeniedCount",
  "JwtKMSAccessDeniedCount",
  "BlockchainKMSGetPublicKeyCallCount",
  "JwtKMSGetPublicKeyCallCount",
  "BlockchainKMSSignDurationMs",
  "JwtKMSSignDurationMs",
  "AuthFailureCount",
  "AuthRefreshReplayDetectedCount"
];

const SECRET_PATTERN =
  /(Bearer\s+[-._~+/A-Za-z0-9]+=*|gho_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+|-----BEGIN [^-]+ PRIVATE KEY-----)/u;

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/kms-cloudwatch-alarms-YYYY-MM-DD.json [--json] [--max-completed-age-hours N]

Validates the operator evidence for the CloudTrail/CloudWatch KMS signing alarm
proof. The check is read-only: it validates a sanitized JSON artifact captured
from AWS CloudFormation, CloudTrail, CloudWatch, and the operator alert channel.

Use --max-completed-age-hours when validating launch evidence so stale artifacts
cannot be reused as current deployed/baseline alert proof.
`;
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    maxCompletedAgeHours: undefined
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

function assertArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
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

function requireDateOnly(value, path, errors) {
  return requireString(value, path, errors, { pattern: /^\d{4}-\d{2}-\d{2}$/u });
}

function requireIsoDate(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    errors.push(`${path} must be an ISO-8601 date/time`);
  }
  return raw;
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

function requireEnum(value, path, errors, allowed) {
  const raw = requireString(value, path, errors);
  if (raw && !allowed.includes(raw)) {
    errors.push(`${path} must be one of: ${allowed.join(", ")}`);
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

function requireStringArray(value, path, errors) {
  const items = assertArray(value, path, errors);
  return items.map((item, index) => requireString(item, `${path}[${index}]`, errors));
}

function requireContainsAll(values, path, required, errors) {
  for (const expected of required) {
    if (!values.includes(expected)) {
      errors.push(`${path} must include ${expected}`);
    }
  }
}

function validateCloudFormation(rawCloudFormation, completedAt, errors) {
  const cloudFormation = assertObject(rawCloudFormation, "cloudFormation", errors);
  const stackStatus = requireEnum(cloudFormation.stackStatus, "cloudFormation.stackStatus", errors, [
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE"
  ]);
  requireString(cloudFormation.stackName, "cloudFormation.stackName", errors);
  requireString(cloudFormation.templateFile, "cloudFormation.templateFile", errors);
  if (cloudFormation.templateFile && cloudFormation.templateFile !== "deploy/iac/cloudwatch/kms-signing-alarms.yaml") {
    errors.push("cloudFormation.templateFile must be deploy/iac/cloudwatch/kms-signing-alarms.yaml");
  }
  requireString(cloudFormation.templateSha256, "cloudFormation.templateSha256", errors, {
    pattern: /^[a-f0-9]{64}$/u
  });
  const deployedAt = requireIsoTimestamp(cloudFormation.deployedAt, "cloudFormation.deployedAt", errors);
  assertNotAfterCompletedAt(deployedAt, "cloudFormation.deployedAt", completedAt, errors);
  if (!stackStatus) return cloudFormation;

  const outputs = assertObject(cloudFormation.outputs, "cloudFormation.outputs", errors);
  requireString(outputs.TrailName, "cloudFormation.outputs.TrailName", errors);
  requireString(outputs.TrailLogGroupName, "cloudFormation.outputs.TrailLogGroupName", errors);
  requireString(outputs.MetricNamespace, "cloudFormation.outputs.MetricNamespace", errors);
  requireString(outputs.DashboardName, "cloudFormation.outputs.DashboardName", errors);
  return cloudFormation;
}

function validateCloudTrail(rawCloudTrail, completedAt, errors) {
  const cloudTrail = assertObject(rawCloudTrail, "cloudTrail", errors);
  requireString(cloudTrail.trailName, "cloudTrail.trailName", errors);
  if (requireBoolean(cloudTrail.isLogging, "cloudTrail.isLogging", errors) !== true) {
    errors.push("cloudTrail.isLogging must be true");
  }
  if (requireBoolean(cloudTrail.logFileValidationEnabled, "cloudTrail.logFileValidationEnabled", errors) !== true) {
    errors.push("cloudTrail.logFileValidationEnabled must be true");
  }
  if (requireBoolean(cloudTrail.kmsManagementEventsIncluded, "cloudTrail.kmsManagementEventsIncluded", errors) !== true) {
    errors.push("cloudTrail.kmsManagementEventsIncluded must be true");
  }
  requireString(cloudTrail.logGroupName, "cloudTrail.logGroupName", errors);
  requireNumber(cloudTrail.s3RetentionDays, "cloudTrail.s3RetentionDays", errors, { integer: true, min: 90 });

  const eventNames = requireStringArray(cloudTrail.eventNames, "cloudTrail.eventNames", errors);
  requireContainsAll(eventNames, "cloudTrail.eventNames", REQUIRED_CLOUDTRAIL_EVENT_NAMES, errors);

  const recentEvents = assertObject(cloudTrail.recentEvents, "cloudTrail.recentEvents", errors);
  const windowStartedAt = requireIsoTimestamp(
    recentEvents.windowStartedAt,
    "cloudTrail.recentEvents.windowStartedAt",
    errors
  );
  const windowFinishedAt = requireIsoTimestamp(
    recentEvents.windowFinishedAt,
    "cloudTrail.recentEvents.windowFinishedAt",
    errors
  );
  assertNotAfterCompletedAt(windowFinishedAt, "cloudTrail.recentEvents.windowFinishedAt", completedAt, errors);
  if (Number.isFinite(windowStartedAt) && Number.isFinite(windowFinishedAt) && windowStartedAt >= windowFinishedAt) {
    errors.push("cloudTrail.recentEvents.windowStartedAt must be before windowFinishedAt");
  }
  requireNumber(recentEvents.signEventsObserved, "cloudTrail.recentEvents.signEventsObserved", errors, {
    integer: true,
    min: 1
  });
  requireNumber(recentEvents.getPublicKeyEventsObserved, "cloudTrail.recentEvents.getPublicKeyEventsObserved", errors, {
    integer: true,
    min: 1
  });
  return cloudTrail;
}

function validateBaseline(rawBaseline, completedAt, errors) {
  const baseline = assertObject(rawBaseline, "baseline", errors);
  requireString(baseline.source, "baseline.source", errors);
  requireString(baseline.method, "baseline.method", errors);
  if (requireBoolean(baseline.baselineDerived, "baseline.baselineDerived", errors) !== true) {
    errors.push("baseline.baselineDerived must be true");
  }
  const windowStartedAt = requireIsoTimestamp(baseline.windowStartedAt, "baseline.windowStartedAt", errors);
  const windowFinishedAt = requireIsoTimestamp(baseline.windowFinishedAt, "baseline.windowFinishedAt", errors);
  assertNotAfterCompletedAt(windowFinishedAt, "baseline.windowFinishedAt", completedAt, errors);
  if (Number.isFinite(windowStartedAt) && Number.isFinite(windowFinishedAt) && windowStartedAt >= windowFinishedAt) {
    errors.push("baseline.windowStartedAt must be before windowFinishedAt");
  }

  const thresholds = assertObject(baseline.thresholds, "baseline.thresholds", errors);
  requireNumber(thresholds.blockchainSignSpikeThresholdPer5Min, "baseline.thresholds.blockchainSignSpikeThresholdPer5Min", errors, {
    integer: true,
    min: 1
  });
  requireNumber(thresholds.jwtSignSpikeThresholdPer5Min, "baseline.thresholds.jwtSignSpikeThresholdPer5Min", errors, {
    integer: true,
    min: 1
  });
  requireNumber(thresholds.authFailureThresholdPer5Min, "baseline.thresholds.authFailureThresholdPer5Min", errors, {
    integer: true,
    min: 1
  });
  return baseline;
}

function expectedThresholdForAlarm(kind, thresholds) {
  if (kind === "blockchain_kms_sign_spike") return thresholds.blockchainSignSpikeThresholdPer5Min;
  if (kind === "jwt_kms_sign_spike") return thresholds.jwtSignSpikeThresholdPer5Min;
  if (kind === "auth_failure_spike") return thresholds.authFailureThresholdPer5Min;
  return 0;
}

function validateAlarms(rawAlarms, baseline, errors) {
  const alarms = assertArray(rawAlarms, "alarms", errors);
  const seenKinds = new Map();
  const thresholds = assertObject(baseline.thresholds, "baseline.thresholds", errors);

  alarms.forEach((rawAlarm, index) => {
    const path = `alarms[${index}]`;
    const alarm = assertObject(rawAlarm, path, errors);
    const kind = requireString(alarm.kind, `${path}.kind`, errors);
    if (kind && !REQUIRED_ALARM_KINDS.has(kind)) {
      errors.push(`${path}.kind is not a recognized KMS/auth alarm kind`);
    }
    if (kind) seenKinds.set(kind, alarm);
    requireString(alarm.name, `${path}.name`, errors);
    if (requireEnum(alarm.stateValue, `${path}.stateValue`, errors, ["OK"]) !== "OK") {
      errors.push(`${path}.stateValue must be OK after proof capture`);
    }
    if (requireBoolean(alarm.actionsEnabled, `${path}.actionsEnabled`, errors) !== true) {
      errors.push(`${path}.actionsEnabled must be true`);
    }
    const actionArns = requireStringArray(alarm.actionArns, `${path}.actionArns`, errors);
    if (actionArns.length === 0) {
      errors.push(`${path}.actionArns must include the page or alert SNS target`);
    }
    requireNumber(alarm.periodSeconds, `${path}.periodSeconds`, errors, { integer: true, min: 60 });
    requireNumber(alarm.evaluationPeriods, `${path}.evaluationPeriods`, errors, { integer: true, min: 1 });
    requireNumber(alarm.datapointsToAlarm, `${path}.datapointsToAlarm`, errors, { integer: true, min: 1 });
    const threshold = requireNumber(alarm.threshold, `${path}.threshold`, errors, { min: 0 });
    const expectedThreshold = expectedThresholdForAlarm(kind, thresholds);
    if (Number.isFinite(threshold) && Number.isFinite(expectedThreshold) && threshold !== expectedThreshold) {
      errors.push(`${path}.threshold must match the baseline-derived threshold for ${kind}`);
    }
  });

  for (const [kind, label] of REQUIRED_ALARM_KINDS.entries()) {
    if (!seenKinds.has(kind)) {
      errors.push(`alarms must include ${label}`);
    }
  }
  return alarms;
}

function validateMetrics(rawMetrics, completedAt, errors) {
  const metrics = assertObject(rawMetrics, "metrics", errors);
  requireString(metrics.namespace, "metrics.namespace", errors);
  const names = requireStringArray(metrics.metricNamesObserved, "metrics.metricNamesObserved", errors);
  requireContainsAll(names, "metrics.metricNamesObserved", REQUIRED_METRICS, errors);
  if (requireBoolean(metrics.durationPercentilesObserved, "metrics.durationPercentilesObserved", errors) !== true) {
    errors.push("metrics.durationPercentilesObserved must be true");
  }
  const observedAt = requireIsoTimestamp(metrics.observedAt, "metrics.observedAt", errors);
  assertNotAfterCompletedAt(observedAt, "metrics.observedAt", completedAt, errors);
  return metrics;
}

function validateAlertDelivery(rawAlertDelivery, completedAt, errors) {
  const alertDelivery = assertObject(rawAlertDelivery, "alertDelivery", errors);
  if (requireBoolean(alertDelivery.delivered, "alertDelivery.delivered", errors) !== true) {
    errors.push("alertDelivery.delivered must be true");
  }
  const alarmKind = requireString(alertDelivery.alarmKind, "alertDelivery.alarmKind", errors);
  if (alarmKind && !REQUIRED_ALARM_KINDS.has(alarmKind)) {
    errors.push("alertDelivery.alarmKind must reference a recognized KMS/auth alarm kind");
  }
  requireString(alertDelivery.alarmName, "alertDelivery.alarmName", errors);
  requireString(alertDelivery.channel, "alertDelivery.channel", errors);
  requireString(alertDelivery.messageId, "alertDelivery.messageId", errors);
  requireString(alertDelivery.testMode, "alertDelivery.testMode", errors);
  const receivedAt = requireIsoTimestamp(alertDelivery.receivedAt, "alertDelivery.receivedAt", errors);
  assertNotAfterCompletedAt(receivedAt, "alertDelivery.receivedAt", completedAt, errors);
  if (requireBoolean(alertDelivery.resetToOkObserved, "alertDelivery.resetToOkObserved", errors) !== true) {
    errors.push("alertDelivery.resetToOkObserved must be true");
  }
  return alertDelivery;
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
  requireString(target.environment, "target.environment", errors, {
    pattern: /^[a-z0-9-]+$/u
  });
  requireString(target.awsRegion, "target.awsRegion", errors, {
    pattern: /^[a-z0-9-]+$/u
  });
  requireHttpUrl(target.apiBaseUrl, "target.apiBaseUrl", errors);

  const cloudFormation = validateCloudFormation(doc.cloudFormation, completedAt, errors);
  const cloudTrail = validateCloudTrail(doc.cloudTrail, completedAt, errors);
  const baseline = validateBaseline(doc.baseline, completedAt, errors);
  const alarms = validateAlarms(doc.alarms, baseline, errors);
  const metrics = validateMetrics(doc.metrics, completedAt, errors);
  const alertDelivery = validateAlertDelivery(doc.alertDelivery, completedAt, errors);

  const outputs = cloudFormation.outputs ?? {};
  if (outputs.TrailName && cloudTrail.trailName && outputs.TrailName !== cloudTrail.trailName) {
    errors.push("cloudTrail.trailName must match cloudFormation.outputs.TrailName");
  }
  if (outputs.TrailLogGroupName && cloudTrail.logGroupName && outputs.TrailLogGroupName !== cloudTrail.logGroupName) {
    errors.push("cloudTrail.logGroupName must match cloudFormation.outputs.TrailLogGroupName");
  }
  if (outputs.MetricNamespace && metrics.namespace && outputs.MetricNamespace !== metrics.namespace) {
    errors.push("metrics.namespace must match cloudFormation.outputs.MetricNamespace");
  }
  if (alertDelivery.alarmKind && !alarms.some((alarm) => alarm.kind === alertDelivery.alarmKind)) {
    errors.push("alertDelivery.alarmKind must match one of the captured alarms");
  }

  const secretScanInput = JSON.stringify(doc);
  if (SECRET_PATTERN.test(secretScanInput)) {
    errors.push("evidence must not include bearer tokens, AWS access keys, Slack webhooks, or private keys");
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      proofDate: doc.proofDate,
      environment: target.environment,
      awsRegion: target.awsRegion,
      stackName: cloudFormation.stackName,
      stackStatus: cloudFormation.stackStatus,
      alarmCount: Array.isArray(doc.alarms) ? doc.alarms.length : 0,
      requiredAlarmCount: REQUIRED_ALARM_KINDS.size,
      baselineWindowFinishedAt: baseline.windowFinishedAt,
      alertDelivered: alertDelivery.delivered === true,
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
    maxCompletedAgeHours: args.maxCompletedAgeHours
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`KMS CloudWatch alarm proof evidence ok: ${args.file}\n`);
  } else {
    process.stderr.write(`KMS CloudWatch alarm proof evidence invalid: ${args.file}\n`);
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
  REQUIRED_ALARM_KINDS,
  REQUIRED_METRICS,
  SCHEMA_VERSION,
  validateEvidence
};
