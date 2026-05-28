import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SCHEMA_VERSION, validateEvidence } from "./check-observability-proof.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-observability-proof.mjs"
);

function validEvidence(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    proofDate: "2026-05-22",
    completedAt: "2026-05-22T18:30:00.000Z",
    operator: {
      name: "Pascal",
      signature: "PK"
    },
    target: {
      environment: "production",
      apiBaseUrl: "https://api.averray.com"
    },
    metricsAuth: {
      checkHostedStackRan: true,
      command: "METRICS_BEARER_TOKEN=$METRICS_BEARER_TOKEN CHECK_METRICS_AUTH=1 ./scripts/ops/check-hosted-stack.sh",
      unauthenticatedStatus: 401,
      authenticatedStatus: 200,
      observedAt: "2026-05-22T18:00:00.000Z"
    },
    alertDestination: {
      webhookConfigured: true,
      deliberateFailureDelivered: true,
      channel: "ops-alerts",
      messageId: "1747936800.123456",
      receivedAt: "2026-05-22T18:05:00.000Z",
      failureMode: "API_HEALTH_URL pointed at a disposable non-existent host"
    },
    sentryLogging: {
      decision: "log_only_deferred",
      structuredLogsVisible: true,
      logSurface: "docker logs agent-backend --tail 50",
      observedLogLine: "{\"level\":\"info\",\"name\":\"averray-mcp\",\"msg\":\"http.listening\"}",
      observedAt: "2026-05-22T18:10:00.000Z",
      sentryReadyObserved: false,
      deferredReason: "Backend Sentry intentionally deferred for v1; structured logs are the active launch surface."
    },
    ...overrides
  };
}

function freshEvidence() {
  const now = new Date();
  const observedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  return validEvidence({
    proofDate: now.toISOString().slice(0, 10),
    completedAt: now.toISOString(),
    metricsAuth: {
      ...validEvidence().metricsAuth,
      observedAt
    },
    alertDestination: {
      ...validEvidence().alertDestination,
      receivedAt: observedAt
    },
    sentryLogging: {
      ...validEvidence().sentryLogging,
      observedAt
    }
  });
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "observability-proof-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

test("validateEvidence accepts log-only observability proof", () => {
  const result = validateEvidence(validEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.metrics.unauthenticatedStatus, 401);
  assert.equal(result.summary.alertDelivered, true);
  assert.equal(result.summary.sentryLoggingDecision, "log_only_deferred");
});

test("validateEvidence accepts fresh launch proof with a max completed age", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-22T19:00:00.000Z"),
    maxCompletedAgeHours: 2
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateEvidence accepts Sentry-enabled observability proof", () => {
  const result = validateEvidence(validEvidence({
    sentryLogging: {
      decision: "sentry_enabled",
      structuredLogsVisible: true,
      logSurface: "docker logs agent-backend --tail 50",
      observedLogLine: "{\"level\":\"info\",\"name\":\"averray-mcp\",\"msg\":\"observability.sentry_ready\"}",
      observedAt: "2026-05-22T18:10:00.000Z",
      sentryReadyObserved: true,
      sentryProject: "averray-backend-prod"
    }
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.sentryLoggingDecision, "sentry_enabled");
});

test("validateEvidence rejects incomplete or misleading proof", () => {
  const doc = validEvidence({
    target: {
      environment: "staging",
      apiBaseUrl: "https://api.example.test"
    },
    metricsAuth: {
      ...validEvidence().metricsAuth,
      command: "METRICS_BEARER_TOKEN=raw-token-123456 CHECK_METRICS_AUTH=0 ./scripts/ops/check-hosted-stack.sh",
      unauthenticatedStatus: 200,
      authenticatedStatus: 503
    },
    alertDestination: {
      ...validEvidence().alertDestination,
      deliberateFailureDelivered: false
    },
    sentryLogging: {
      ...validEvidence().sentryLogging,
      observedLogLine: "Bearer very-secret-token"
    }
  });

  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("target.environment must be production"));
  assert.ok(result.errors.includes("target.apiBaseUrl must be the hosted production API base URL"));
  assert.ok(result.errors.includes("metricsAuth.command must include CHECK_METRICS_AUTH=1"));
  assert.ok(result.errors.includes("metricsAuth.command must not include the raw metrics token"));
  assert.ok(result.errors.includes("metricsAuth.unauthenticatedStatus must be 401"));
  assert.ok(result.errors.includes("metricsAuth.authenticatedStatus must be 200"));
  assert.ok(result.errors.includes("alertDestination.deliberateFailureDelivered must be true"));
  assert.ok(result.errors.includes("sentryLogging.observedLogLine must not contain secret-looking material"));
  assert.ok(result.errors.includes("evidence must not include bearer tokens, provider API keys, or Sentry DSNs"));
});

test("validateEvidence rejects stale or future-dated launch proof", () => {
  const stale = validateEvidence(validEvidence(), {
    now: new Date("2026-05-25T18:31:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes("completedAt must be within 24 hour(s)"));

  const future = validateEvidence(validEvidence({
    proofDate: "2026-05-22",
    completedAt: "2026-05-22T19:10:00.000Z"
  }), {
    now: new Date("2026-05-22T19:00:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(future.ok, false);
  assert.ok(future.errors.includes("completedAt must not be in the future"));
});

test("validateEvidence rejects mismatched or post-completion timestamps", () => {
  const result = validateEvidence(validEvidence({
    proofDate: "2026-05-23",
    metricsAuth: {
      ...validEvidence().metricsAuth,
      observedAt: "2026-05-22T18:40:01.000Z"
    },
    alertDestination: {
      ...validEvidence().alertDestination,
      receivedAt: "2026-05-22T18:40:01.000Z"
    },
    sentryLogging: {
      ...validEvidence().sentryLogging,
      observedAt: "2026-05-22T18:40:01.000Z"
    }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("proofDate must match completedAt UTC date"));
  assert.ok(result.errors.includes("metricsAuth.observedAt must not be later than completedAt"));
  assert.ok(result.errors.includes("alertDestination.receivedAt must not be later than completedAt"));
  assert.ok(result.errors.includes("sentryLogging.observedAt must not be later than completedAt"));
});

test("validateEvidence rejects invalid freshness options", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-22T19:00:00.000Z"),
    maxCompletedAgeHours: 0
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("maxCompletedAgeHours must be a positive number"));
});

test("validateEvidence rejects Sentry-enabled proof without ready observation", () => {
  const result = validateEvidence(validEvidence({
    sentryLogging: {
      decision: "sentry_enabled",
      structuredLogsVisible: true,
      logSurface: "docker logs agent-backend --tail 50",
      observedLogLine: "{\"level\":\"info\",\"name\":\"averray-mcp\",\"msg\":\"http.listening\"}",
      observedAt: "2026-05-22T18:10:00.000Z",
      sentryReadyObserved: false,
      sentryProject: "averray-backend-prod"
    }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("sentryLogging.sentryReadyObserved must be true when Sentry is enabled"));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.operator, "Pascal");
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
    alertDestination: {
      ...validEvidence().alertDestination,
      webhookConfigured: false
    }
  }));
  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /alertDestination\.webhookConfigured must be true/u);
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
