const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RESEND_API_BASE_URL = "https://api.resend.com";

export class BootstrapSelfReportSchedulerService {
  constructor(upstreamStatusPoller, eventBus = undefined, {
    enabled = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    sendOnStart = false,
    from = undefined,
    to = [],
    subjectPrefix = "Averray bootstrap self-report",
    resendApiKey = undefined,
    resendApiBaseUrl = DEFAULT_RESEND_API_BASE_URL,
    fetchImpl = fetch,
    emailSender = undefined,
    logger = console
  } = {}) {
    this.upstreamStatusPoller = upstreamStatusPoller;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.sendOnStart = sendOnStart;
    this.from = normalizeText(from);
    this.to = normalizeRecipients(to);
    this.subjectPrefix = normalizeText(subjectPrefix) || "Averray bootstrap self-report";
    this.resendApiKey = normalizeText(resendApiKey);
    this.resendApiBaseUrl = normalizeText(resendApiBaseUrl) || DEFAULT_RESEND_API_BASE_URL;
    this.fetchImpl = fetchImpl;
    this.emailSender = emailSender;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.nextRunAt = undefined;
    this.lastRun = undefined;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.scheduleNext(this.sendOnStart ? 0 : this.intervalMs);
  }

  stop() {
    this.running = false;
    this.nextRunAt = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      sendOnStart: this.sendOnStart,
      recipientCount: this.to.length,
      providerConfigured: Boolean(this.emailSender || (this.resendApiKey && this.from && this.to.length)),
      nextRunAt: this.nextRunAt,
      lastRun: this.lastRun
    };
  }

  async runOnce(now = new Date()) {
    const summary = {
      startedAt: now.toISOString(),
      finishedAt: undefined,
      status: "pending",
      skipped: [],
      errors: [],
      report: undefined,
      email: undefined
    };

    if (!this.enabled) {
      summary.status = "skipped";
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    if (!this.upstreamStatusPoller?.generateWeeklyReport) {
      summary.status = "skipped";
      summary.skipped.push({ reason: "missing_report_generator" });
      return this.finishRun(summary);
    }
    if (!this.hasEmailConfig()) {
      summary.status = "skipped";
      summary.skipped.push({ reason: "missing_email_config" });
      return this.finishRun(summary);
    }

    try {
      const report = await this.upstreamStatusPoller.generateWeeklyReport({ now });
      const email = buildBootstrapSelfReportEmail(report, {
        now,
        from: this.from,
        to: this.to,
        subjectPrefix: this.subjectPrefix
      });
      const sendResult = await this.sendEmail(email, {
        idempotencyKey: `bootstrap-self-report-${isoDate(now)}`
      });
      summary.status = "sent";
      summary.report = compactReport(report);
      summary.email = {
        to: this.to,
        subject: email.subject,
        providerId: sendResult?.id ?? sendResult?.data?.id
      };
      this.eventBus?.publish?.({
        id: `bootstrap-self-report-${Date.now()}`,
        topic: "bootstrap.self_report.sent",
        timestamp: now.toISOString(),
        data: {
          status: summary.status,
          report: summary.report,
          email: summary.email
        }
      });
    } catch (error) {
      summary.status = "failed";
      summary.errors.push({ message: error?.message ?? String(error) });
      this.logger.warn?.({ err: error }, "bootstrap_self_report.send_failed");
    }

    return this.finishRun(summary);
  }

  async runOnceAndSchedule() {
    await this.runOnce(new Date());
    if (!this.running) return;
    this.scheduleNext(this.intervalMs);
  }

  hasEmailConfig() {
    return Boolean(this.emailSender || (this.resendApiKey && this.from && this.to.length));
  }

  async sendEmail(email, { idempotencyKey } = {}) {
    if (this.emailSender) {
      return this.emailSender(email, { idempotencyKey });
    }
    return sendResendEmail(email, {
      apiKey: this.resendApiKey,
      apiBaseUrl: this.resendApiBaseUrl,
      fetchImpl: this.fetchImpl,
      idempotencyKey
    });
  }

  scheduleNext(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Number(delayMs) || 0);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      void this.runOnceAndSchedule();
    }, delay);
    this.timer.unref?.();
  }

  finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }
}

export function buildBootstrapSelfReportEmail(report, {
  now = new Date(),
  from = undefined,
  to = [],
  subjectPrefix = "Averray bootstrap self-report"
} = {}) {
  const subject = `${subjectPrefix} - ${isoDate(now)}`;
  const mergeRate = report.mergeRate === null || report.mergeRate === undefined
    ? "n/a"
    : formatPercent(report.mergeRate);
  const topReasons = report.topCloseReasons?.length
    ? report.topCloseReasons.map((entry) => `- ${entry.reason}: ${entry.count}`).join("\n")
    : "- none";
  const text = [
    "Averray weekly bootstrap self-report",
    "",
    `Window: ${report.window?.from ?? "n/a"} to ${report.window?.to ?? "n/a"}`,
    `Total funded jobs: ${report.totalFundedJobs}`,
    `Final jobs: ${report.finalJobs}`,
    `Successful jobs: ${report.successfulJobs}`,
    `Merge rate: ${mergeRate}`,
    `Total reserved: ${report.totalReserved}`,
    `Confirmed payout: ${report.confirmedPayout}`,
    `Total receipts: ${report.totalReceipts}`,
    "",
    "Statuses:",
    JSON.stringify(report.statuses ?? {}, null, 2),
    "",
    "Source types:",
    JSON.stringify(report.sourceTypes ?? {}, null, 2),
    "",
    "Top close reasons:",
    topReasons,
    "",
    "Raw report:",
    JSON.stringify(report, null, 2)
  ].join("\n");
  const html = [
    "<h1>Averray weekly bootstrap self-report</h1>",
    "<dl>",
    `<dt>Window</dt><dd>${escapeHtml(report.window?.from ?? "n/a")} to ${escapeHtml(report.window?.to ?? "n/a")}</dd>`,
    `<dt>Total funded jobs</dt><dd>${escapeHtml(report.totalFundedJobs)}</dd>`,
    `<dt>Final jobs</dt><dd>${escapeHtml(report.finalJobs)}</dd>`,
    `<dt>Successful jobs</dt><dd>${escapeHtml(report.successfulJobs)}</dd>`,
    `<dt>Merge rate</dt><dd>${escapeHtml(mergeRate)}</dd>`,
    `<dt>Total reserved</dt><dd>${escapeHtml(report.totalReserved)}</dd>`,
    `<dt>Confirmed payout</dt><dd>${escapeHtml(report.confirmedPayout)}</dd>`,
    `<dt>Total receipts</dt><dd>${escapeHtml(report.totalReceipts)}</dd>`,
    "</dl>",
    "<h2>Top close reasons</h2>",
    `<pre>${escapeHtml(topReasons)}</pre>`,
    "<h2>Raw report</h2>",
    `<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`
  ].join("\n");
  return {
    from,
    to,
    subject,
    text,
    html
  };
}

export async function sendResendEmail(email, {
  apiKey,
  apiBaseUrl = DEFAULT_RESEND_API_BASE_URL,
  fetchImpl = fetch,
  idempotencyKey = undefined
} = {}) {
  const baseUrl = String(apiBaseUrl || DEFAULT_RESEND_API_BASE_URL).replace(/\/+$/u, "");
  const response = await fetchImpl(`${baseUrl}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
    },
    body: JSON.stringify({
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html
    })
  });
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }
  if (!response.ok) {
    throw new Error(`Resend email send failed (${response.status}): ${bodyText}`);
  }
  return body;
}

export function loadBootstrapSelfReportSchedulerConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.BOOTSTRAP_SELF_REPORT_ENABLED),
    intervalMs: parsePositiveInt(env.BOOTSTRAP_SELF_REPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    sendOnStart: parseBooleanEnv(env.BOOTSTRAP_SELF_REPORT_SEND_ON_START),
    from: env.BOOTSTRAP_SELF_REPORT_FROM?.trim(),
    to: parseRecipients(env.BOOTSTRAP_SELF_REPORT_TO),
    subjectPrefix: env.BOOTSTRAP_SELF_REPORT_SUBJECT_PREFIX?.trim() || "Averray bootstrap self-report",
    resendApiKey: env.RESEND_API_KEY?.trim() || env.BOOTSTRAP_SELF_REPORT_RESEND_API_KEY?.trim(),
    resendApiBaseUrl: env.RESEND_API_BASE_URL?.trim() || DEFAULT_RESEND_API_BASE_URL
  };
}

function compactReport(report) {
  return {
    generatedAt: report.generatedAt,
    window: report.window,
    totalFundedJobs: report.totalFundedJobs,
    finalJobs: report.finalJobs,
    successfulJobs: report.successfulJobs,
    mergeRate: report.mergeRate,
    totalReserved: report.totalReserved,
    confirmedPayout: report.confirmedPayout,
    totalReceipts: report.totalReceipts,
    topCloseReasons: report.topCloseReasons
  };
}

function parseRecipients(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeRecipients(parsed);
  } catch {
    // Fall through to comma-separated parsing.
  }
  return normalizeRecipients(String(raw).split(","));
}

function normalizeRecipients(value) {
  return (Array.isArray(value) ? value : [value])
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseBooleanEnv(raw) {
  if (raw === undefined || raw === null || raw === "") return false;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
