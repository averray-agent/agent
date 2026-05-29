import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  REQUIRED_ALARM_KINDS,
  REQUIRED_METRICS,
  SCHEMA_VERSION,
  validateEvidence
} from "./check-kms-cloudwatch-alarm-proof.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-kms-cloudwatch-alarm-proof.mjs"
);

function validAlarm(kind, threshold) {
  return {
    kind,
    name: `averray-testnet-${kind.replaceAll("_", "-")}`,
    stateValue: "OK",
    actionsEnabled: true,
    actionArns: ["arn:aws:sns:eu-central-2:079209845430:averray-testnet-alerts"],
    threshold,
    periodSeconds: kind.includes("access_denied") || kind.includes("refresh_replay") ? 60 : 300,
    evaluationPeriods: 1,
    datapointsToAlarm: 1
  };
}

function validEvidence(overrides = {}) {
  const thresholds = {
    blockchainSignSpikeThresholdPer5Min: 40,
    jwtSignSpikeThresholdPer5Min: 80,
    authFailureThresholdPer5Min: 120
  };
  const alarmThresholds = new Map([
    ["blockchain_kms_sign_spike", thresholds.blockchainSignSpikeThresholdPer5Min],
    ["jwt_kms_sign_spike", thresholds.jwtSignSpikeThresholdPer5Min],
    ["auth_failure_spike", thresholds.authFailureThresholdPer5Min]
  ]);

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    proofDate: "2026-05-29",
    completedAt: "2026-05-29T12:00:00.000Z",
    operator: {
      name: "Pascal",
      signature: "PK"
    },
    target: {
      environment: "testnet",
      awsRegion: "eu-central-2",
      apiBaseUrl: "https://api.averray.com"
    },
    cloudFormation: {
      stackName: "averray-testnet-kms-signing-alarms",
      stackStatus: "UPDATE_COMPLETE",
      deployedAt: "2026-05-29T11:00:00.000Z",
      templateFile: "deploy/iac/cloudwatch/kms-signing-alarms.yaml",
      templateSha256: "a".repeat(64),
      outputs: {
        TrailName: "averray-testnet-kms-audit",
        TrailLogGroupName: "/averray/testnet/cloudtrail/kms",
        MetricNamespace: "Averray/KMS",
        DashboardName: "averray-testnet-kms-signing"
      }
    },
    cloudTrail: {
      trailName: "averray-testnet-kms-audit",
      isLogging: true,
      logFileValidationEnabled: true,
      kmsManagementEventsIncluded: true,
      logGroupName: "/averray/testnet/cloudtrail/kms",
      s3RetentionDays: 90,
      eventNames: ["Sign", "GetPublicKey", "DescribeKey", "Encrypt", "Decrypt"],
      recentEvents: {
        windowStartedAt: "2026-05-29T11:00:00.000Z",
        windowFinishedAt: "2026-05-29T11:55:00.000Z",
        signEventsObserved: 6,
        getPublicKeyEventsObserved: 2
      }
    },
    baseline: {
      source: "CloudWatch get-metric-data over the hosted smoke soak window",
      method: "5-minute maxima plus launch headroom",
      baselineDerived: true,
      windowStartedAt: "2026-05-29T09:00:00.000Z",
      windowFinishedAt: "2026-05-29T11:00:00.000Z",
      thresholds
    },
    alarms: Array.from(REQUIRED_ALARM_KINDS.keys(), (kind) => validAlarm(kind, alarmThresholds.get(kind) ?? 0)),
    metrics: {
      namespace: "Averray/KMS",
      metricNamesObserved: [...REQUIRED_METRICS],
      durationPercentilesObserved: true,
      observedAt: "2026-05-29T11:55:00.000Z"
    },
    alertDelivery: {
      delivered: true,
      alarmKind: "jwt_kms_sign_spike",
      alarmName: "averray-testnet-jwt-kms-sign-spike",
      channel: "ops-alerts",
      messageId: "1780055700.123456",
      testMode: "temporary alarm threshold override",
      receivedAt: "2026-05-29T11:58:00.000Z",
      resetToOkObserved: true
    }
  };

  return {
    ...doc,
    ...overrides
  };
}

function freshEvidence() {
  const now = new Date();
  const observedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  return validEvidence({
    proofDate: now.toISOString().slice(0, 10),
    completedAt: now.toISOString(),
    cloudFormation: {
      ...validEvidence().cloudFormation,
      deployedAt: observedAt
    },
    cloudTrail: {
      ...validEvidence().cloudTrail,
      recentEvents: {
        ...validEvidence().cloudTrail.recentEvents,
        windowStartedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        windowFinishedAt: observedAt
      }
    },
    baseline: {
      ...validEvidence().baseline,
      windowStartedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      windowFinishedAt: observedAt
    },
    metrics: {
      ...validEvidence().metrics,
      observedAt
    },
    alertDelivery: {
      ...validEvidence().alertDelivery,
      receivedAt: observedAt
    }
  });
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "kms-cloudwatch-proof-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

test("validateEvidence accepts complete KMS CloudWatch alarm proof", () => {
  const result = validateEvidence(validEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.environment, "testnet");
  assert.equal(result.summary.stackStatus, "UPDATE_COMPLETE");
  assert.equal(result.summary.alertDelivered, true);
});

test("validateEvidence accepts fresh proof with max age enforcement", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-29T13:00:00.000Z"),
    maxCompletedAgeHours: 2
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateEvidence rejects unproven CloudTrail and baseline inputs", () => {
  const doc = validEvidence({
    cloudFormation: {
      ...validEvidence().cloudFormation,
      stackStatus: "ROLLBACK_COMPLETE",
      templateSha256: "not-a-sha"
    },
    cloudTrail: {
      ...validEvidence().cloudTrail,
      isLogging: false,
      kmsManagementEventsIncluded: false,
      s3RetentionDays: 30,
      eventNames: ["Sign"],
      recentEvents: {
        ...validEvidence().cloudTrail.recentEvents,
        signEventsObserved: 0
      }
    },
    baseline: {
      ...validEvidence().baseline,
      baselineDerived: false,
      thresholds: {
        ...validEvidence().baseline.thresholds,
        jwtSignSpikeThresholdPer5Min: 0
      }
    }
  });

  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("cloudFormation.stackStatus must be one of: CREATE_COMPLETE, UPDATE_COMPLETE"));
  assert.ok(result.errors.includes("cloudFormation.templateSha256 has an invalid format"));
  assert.ok(result.errors.includes("cloudTrail.isLogging must be true"));
  assert.ok(result.errors.includes("cloudTrail.kmsManagementEventsIncluded must be true"));
  assert.ok(result.errors.includes("cloudTrail.s3RetentionDays must be >= 90"));
  assert.ok(result.errors.includes("cloudTrail.eventNames must include GetPublicKey"));
  assert.ok(result.errors.includes("cloudTrail.recentEvents.signEventsObserved must be >= 1"));
  assert.ok(result.errors.includes("baseline.baselineDerived must be true"));
  assert.ok(result.errors.includes("baseline.thresholds.jwtSignSpikeThresholdPer5Min must be >= 1"));
});

test("validateEvidence rejects missing alarm coverage and unwired actions", () => {
  const doc = structuredClone(validEvidence());
  doc.alarms = doc.alarms.filter((alarm) => alarm.kind !== "jwt_kms_sign_error");
  doc.alarms[0] = {
    ...doc.alarms[0],
    stateValue: "INSUFFICIENT_DATA",
    actionsEnabled: false,
    actionArns: []
  };
  doc.alarms.find((alarm) => alarm.kind === "blockchain_kms_sign_spike").threshold = 999;

  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("alarms[0].stateValue must be one of: OK"));
  assert.ok(result.errors.includes("alarms[0].stateValue must be OK after proof capture"));
  assert.ok(result.errors.includes("alarms[0].actionsEnabled must be true"));
  assert.ok(result.errors.includes("alarms[0].actionArns must include the page or alert SNS target"));
  assert.ok(result.errors.some((error) => /threshold must match the baseline-derived threshold for blockchain_kms_sign_spike/u.test(error)));
  assert.ok(result.errors.includes("alarms must include JWT signer kms:Sign error alarm"));
});

test("validateEvidence rejects missing metrics and alert proof", () => {
  const doc = validEvidence({
    metrics: {
      ...validEvidence().metrics,
      metricNamesObserved: ["BlockchainKMSSignCallCount"],
      durationPercentilesObserved: false
    },
    alertDelivery: {
      ...validEvidence().alertDelivery,
      delivered: false,
      alarmKind: "unknown",
      resetToOkObserved: false
    }
  });

  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("metrics.metricNamesObserved must include JwtKMSSignCallCount"));
  assert.ok(result.errors.includes("metrics.durationPercentilesObserved must be true"));
  assert.ok(result.errors.includes("alertDelivery.delivered must be true"));
  assert.ok(result.errors.includes("alertDelivery.alarmKind must reference a recognized KMS/auth alarm kind"));
  assert.ok(result.errors.includes("alertDelivery.resetToOkObserved must be true"));
});

test("validateEvidence rejects stale, future-dated, mismatched, and secret-bearing proof", () => {
  const stale = validateEvidence(validEvidence(), {
    now: new Date("2026-05-31T12:01:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes("completedAt must be within 24 hour(s)"));

  const future = validateEvidence(validEvidence({
    completedAt: "2026-05-29T13:10:00.000Z"
  }), {
    now: new Date("2026-05-29T13:00:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(future.ok, false);
  assert.ok(future.errors.includes("completedAt must not be in the future"));

  const leaked = validateEvidence(validEvidence({
    proofDate: "2026-05-28",
    alertDelivery: {
      ...validEvidence().alertDelivery,
      messageId: "https://hooks.slack.com/services/T000/B000/secret"
    }
  }));
  assert.equal(leaked.ok, false);
  assert.ok(leaked.errors.includes("proofDate must match completedAt UTC date"));
  assert.ok(leaked.errors.includes("evidence must not include bearer tokens, AWS access keys, Slack webhooks, or private keys"));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.stackName, "averray-testnet-kms-signing-alarms");
});

test("CLI accepts max completed age for fresh evidence", async () => {
  const file = await writeEvidenceFile(freshEvidence());
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--file",
    file,
    "--max-completed-age-hours",
    "1",
    "--json"
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    alertDelivery: {
      ...validEvidence().alertDelivery,
      delivered: false
    }
  }));
  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /alertDelivery\.delivered must be true/u);
      return true;
    }
  );
});

test("CLI exits non-zero for invalid max completed age", async () => {
  const file = await writeEvidenceFile(validEvidence());
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      scriptPath,
      "--file",
      file,
      "--max-completed-age-hours",
      "0"
    ]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /--max-completed-age-hours must be a positive number/u);
      return true;
    }
  );
});
