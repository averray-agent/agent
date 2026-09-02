import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOTSTRAP_SELF_REPORT_FAILURE_CODES,
  BootstrapSelfReportSchedulerService,
  buildBootstrapSelfReportEmail,
  loadBootstrapSelfReportSchedulerConfig,
  sendResendEmail
} from "./bootstrap-self-report-scheduler.js";

const report = {
  generatedAt: "2026-05-08T00:00:00.000Z",
  window: {
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-05-08T00:00:00.000Z"
  },
  totalFundedJobs: 4,
  finalJobs: 2,
  successfulJobs: 1,
  mergeRate: 0.5,
  totalReserved: 7,
  confirmedPayout: 2,
  totalReceipts: 3,
  statuses: { merged: 1, closed_unmerged: 1, open: 2 },
  sourceTypes: { github_issue: 3, wikipedia_article: 1 },
  topCloseReasons: [{ reason: "closed_unmerged", count: 1 }]
};

function createMemoryServiceStateStore() {
  const states = new Map();
  return {
    states,
    async getServiceState(scope) {
      return states.get(scope);
    },
    async upsertServiceState(scope, state) {
      const existing = states.get(scope) ?? {};
      const merged = { ...existing, ...state, updatedAt: new Date().toISOString() };
      states.set(scope, merged);
      return merged;
    }
  };
}

test("buildBootstrapSelfReportEmail renders operator-ready text and HTML", () => {
  const email = buildBootstrapSelfReportEmail(report, {
    now: new Date("2026-05-08T12:00:00.000Z"),
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"]
  });

  assert.equal(email.subject, "Averray bootstrap self-report - 2026-05-08");
  assert.match(email.text, /Merge rate: 50\.0%/u);
  assert.match(email.html, /closed_unmerged/u);
});

test("BootstrapSelfReportSchedulerService sends the generated report", async () => {
  const events = [];
  const poller = {
    async generateWeeklyReport() {
      return report;
    }
  };
  const scheduler = new BootstrapSelfReportSchedulerService(poller, {
    publish(event) {
      events.push(event);
    }
  }, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    emailSender: async (email, options) => {
      assert.equal(email.to[0], "pascal@example.com");
      assert.equal(options.idempotencyKey, "bootstrap-self-report-2026-05-08");
      return { id: "email_123" };
    }
  });

  const now = new Date("2026-05-08T12:00:00.000Z");
  const result = await scheduler.runOnce(now);

  assert.equal(result.status, "sent");
  assert.equal(result.report.mergeRate, 0.5);
  assert.equal(result.email.providerId, "email_123");
  assert.equal(events[0].topic, "bootstrap.self_report.sent");

  const status = await scheduler.getStatus();
  assert.equal(status.lastAttemptedAt, now.toISOString());
  assert.equal(status.lastSuccessfulAt, now.toISOString());
  assert.equal(status.lastFailureReason, undefined);
  assert.equal(status.from, "Averray <ops@example.com>");
  assert.deepEqual(status.to, ["pascal@example.com"]);
});

test("BootstrapSelfReportSchedulerService skips when email config is missing", async () => {
  const scheduler = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true
  });

  const result = await scheduler.runOnce(new Date("2026-05-08T12:00:00.000Z"));

  assert.equal(result.status, "skipped");
  assert.deepEqual(result.skipped, [{ reason: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_API_KEY }]);
});

test("provider non-2xx populates lastFailureReason and leaves lastSuccessfulAt", async () => {
  const stateStore = createMemoryServiceStateStore();
  const previousSend = new Date("2026-05-01T00:00:00.000Z");
  // Seed a prior successful run so we can prove a later failure does NOT
  // overwrite lastSuccessfulAt.
  await stateStore.upsertServiceState("bootstrap-self-report", {
    lastAttemptedAt: previousSend.toISOString(),
    lastSuccessfulAt: previousSend.toISOString(),
    lastFailureReason: undefined
  });

  const scheduler = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    resendApiKey: "secret-key-do-not-leak",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async text() {
        return JSON.stringify({ message: "rate limit exceeded" });
      }
    }),
    stateStore
  });

  const now = new Date("2026-05-08T12:00:00.000Z");
  const result = await scheduler.runOnce(now);

  assert.equal(result.status, "failed");
  const status = await scheduler.getStatus();
  assert.equal(status.lastAttemptedAt, now.toISOString());
  assert.equal(status.lastSuccessfulAt, previousSend.toISOString());
  assert.equal(status.lastFailureReason.code, BOOTSTRAP_SELF_REPORT_FAILURE_CODES.PROVIDER_NON_2XX);
  assert.equal(status.lastFailureReason.providerStatus, 429);
  assert.equal(status.lastFailureReason.message, "rate limit exceeded");
});

test("provider failure message is truncated to keep status payload bounded", async () => {
  const huge = "x".repeat(2000);
  const scheduler = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    resendApiKey: "secret",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return JSON.stringify({ message: huge });
      }
    })
  });

  await scheduler.runOnce(new Date("2026-05-08T12:00:00.000Z"));
  const status = await scheduler.getStatus();
  assert.ok(status.lastFailureReason.message.length < huge.length);
  assert.ok(status.lastFailureReason.message.endsWith("..."));
});

test("missing API key reports the precise misconfiguration without crashing", async () => {
  const scheduler = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"]
    // resendApiKey intentionally absent
  });

  const result = await scheduler.runOnce(new Date("2026-05-08T12:00:00.000Z"));
  assert.equal(result.status, "skipped");
  assert.equal(result.skipped[0].reason, BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_API_KEY);

  const status = await scheduler.getStatus();
  assert.equal(status.lastFailureReason.code, BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_API_KEY);
  // Misconfiguration must not mark a real attempt — operators check
  // lastAttemptedAt to know "did we hit the provider at all?".
  assert.equal(status.lastAttemptedAt, undefined);
  assert.equal(status.lastSuccessfulAt, undefined);
});

test("missing from address is reported distinctly from missing recipients / key", async () => {
  const noFrom = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() { return report; }
  }, undefined, {
    enabled: true,
    to: ["pascal@example.com"],
    resendApiKey: "secret"
  });
  const noFromResult = await noFrom.runOnce(new Date("2026-05-08T12:00:00.000Z"));
  assert.equal(noFromResult.skipped[0].reason, BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_FROM_ADDRESS);

  const noTo = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() { return report; }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    resendApiKey: "secret"
  });
  const noToResult = await noTo.runOnce(new Date("2026-05-08T12:00:00.000Z"));
  assert.equal(noToResult.skipped[0].reason, BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_RECIPIENTS);
});

test("status projection does not leak the API key or full provider response", async () => {
  const apiKey = "re_super_secret_should_not_leak";
  const providerBody = JSON.stringify({
    // A defective provider that echoes the auth header back in its error
    // envelope — we must not relay this to /admin/status callers.
    message: "Unauthorized",
    debug: { authorization: `Bearer ${apiKey}` }
  });
  const scheduler = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    resendApiKey: apiKey,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return providerBody;
      }
    })
  });

  await scheduler.runOnce(new Date("2026-05-08T12:00:00.000Z"));
  const status = await scheduler.getStatus();
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(apiKey), false, "API key must not appear in status payload");
  assert.equal(serialized.includes("debug"), false, "raw provider body must not appear in status payload");
  assert.equal(status.lastFailureReason.code, BOOTSTRAP_SELF_REPORT_FAILURE_CODES.PROVIDER_NON_2XX);
  assert.equal(status.lastFailureReason.providerStatus, 401);
  assert.equal(status.lastFailureReason.message, "Unauthorized");
});

test("evidence persists across scheduler instances when a stateStore is provided", async () => {
  const stateStore = createMemoryServiceStateStore();
  const first = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    emailSender: async () => ({ id: "email_persisted" }),
    stateStore
  });
  const now = new Date("2026-05-08T12:00:00.000Z");
  await first.runOnce(now);

  const second = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    emailSender: async () => ({ id: "ignored" }),
    stateStore
  });
  const status = await second.getStatus();
  assert.equal(status.lastSuccessfulAt, now.toISOString());
  assert.equal(status.evidencePersistenceNote, undefined);
});

test("without stateStore, getStatus advertises in-process evidence", async () => {
  const scheduler = new BootstrapSelfReportSchedulerService({
    async generateWeeklyReport() {
      return report;
    }
  }, undefined, {
    enabled: true,
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    emailSender: async () => ({ id: "email_mem" })
  });
  const status = await scheduler.getStatus();
  assert.equal(status.evidencePersistenceNote, "in-process state, resets on restart");
});

test("sendResendEmail posts to the Resend emails endpoint", async () => {
  const calls = [];
  const result = await sendResendEmail({
    from: "Averray <ops@example.com>",
    to: ["pascal@example.com"],
    subject: "Report",
    text: "hello",
    html: "<p>hello</p>"
  }, {
    apiKey: "secret",
    idempotencyKey: "report-2026-05-08",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ id: "email_456" });
        }
      };
    }
  });

  assert.equal(result.id, "email_456");
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "report-2026-05-08");
  assert.deepEqual(JSON.parse(calls[0].options.body).to, ["pascal@example.com"]);
});

test("loadBootstrapSelfReportSchedulerConfig parses env", () => {
  const config = loadBootstrapSelfReportSchedulerConfig({
    BOOTSTRAP_SELF_REPORT_ENABLED: "true",
    BOOTSTRAP_SELF_REPORT_INTERVAL_MS: "1234",
    BOOTSTRAP_SELF_REPORT_SEND_ON_START: "yes",
    BOOTSTRAP_SELF_REPORT_FROM: "Averray <ops@example.com>",
    BOOTSTRAP_SELF_REPORT_TO: "pascal@example.com,ops@example.com",
    BOOTSTRAP_SELF_REPORT_SUBJECT_PREFIX: "Weekly Averray report",
    RESEND_API_KEY: "secret"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.intervalMs, 1234);
  assert.equal(config.sendOnStart, true);
  assert.deepEqual(config.to, ["pascal@example.com", "ops@example.com"]);
  assert.equal(config.subjectPrefix, "Weekly Averray report");
  assert.equal(config.resendApiKey, "secret");
});
