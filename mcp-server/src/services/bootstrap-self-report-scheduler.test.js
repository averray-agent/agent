import test from "node:test";
import assert from "node:assert/strict";

import {
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

  const result = await scheduler.runOnce(new Date("2026-05-08T12:00:00.000Z"));

  assert.equal(result.status, "sent");
  assert.equal(result.report.mergeRate, 0.5);
  assert.equal(result.email.providerId, "email_123");
  assert.equal(events[0].topic, "bootstrap.self_report.sent");
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
  assert.deepEqual(result.skipped, [{ reason: "missing_email_config" }]);
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
