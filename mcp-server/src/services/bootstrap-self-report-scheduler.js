const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RESEND_API_BASE_URL = "https://api.resend.com";
const DEFAULT_STATE_SCOPE = "bootstrap-self-report";
const FAILURE_MESSAGE_MAX_LENGTH = 240;

// Failure-reason codes are stable strings the operator dashboard / launch
// checklist greps against — keep them in one place so the test, the projection,
// and the docs all agree on the spelling.
export const BOOTSTRAP_SELF_REPORT_FAILURE_CODES = Object.freeze({
  PROVIDER_NON_2XX: "provider_non_2xx",
  PROVIDER_REQUEST_FAILED: "provider_request_failed",
  MISSING_API_KEY: "missing_api_key",
  MISSING_FROM_ADDRESS: "missing_from_address",
  MISSING_RECIPIENTS: "missing_recipients",
  MISSING_REPORT_GENERATOR: "missing_report_generator",
  DISABLED: "disabled",
  REPORT_GENERATION_FAILED: "report_generation_failed"
});

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
    logger = console,
    stateStore = undefined,
    stateScope = DEFAULT_STATE_SCOPE
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
    this.stateStore = stateStore;
    this.stateScope = stateScope;
    this.running = false;
    this.timer = undefined;
    this.nextRunAt = undefined;
    this.lastRun = undefined;
    // In-process mirror of the persisted evidence. Used when stateStore is
    // absent so getStatus still returns the recent attempt; when stateStore
    // is provided this is refreshed from persisted state on each read.
    this.evidence = {
      lastAttemptedAt: undefined,
      lastSuccessfulAt: undefined,
      lastFailureReason: undefined
    };
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
    const persisted = await this.readPersistedEvidence();
    const evidence = persisted ?? this.evidence;
    const status = {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      sendOnStart: this.sendOnStart,
      from: this.from || undefined,
      to: [...this.to],
      recipientCount: this.to.length,
      providerConfigured: Boolean(this.emailSender || (this.resendApiKey && this.from && this.to.length)),
      nextRunAt: this.nextRunAt,
      lastRun: this.lastRun,
      lastAttemptedAt: evidence.lastAttemptedAt,
      lastSuccessfulAt: evidence.lastSuccessfulAt,
      lastFailureReason: evidence.lastFailureReason ?? undefined
    };
    if (!this.stateStore) {
      // Operators reading this need to know that a fresh process boot zeroes
      // the timestamps until the next scheduler tick refreshes them.
      status.evidencePersistenceNote = "in-process state, resets on restart";
    }
    return status;
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
      summary.skipped.push({ reason: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.DISABLED });
      return this.finishRun(summary);
    }
    if (!this.upstreamStatusPoller?.generateWeeklyReport) {
      summary.status = "skipped";
      summary.skipped.push({ reason: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_REPORT_GENERATOR });
      await this.recordMisconfiguration(now, {
        code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_REPORT_GENERATOR,
        message: "Upstream status poller is missing generateWeeklyReport()"
      });
      return this.finishRun(summary);
    }
    const configCheck = this.describeEmailConfigGap();
    if (configCheck) {
      summary.status = "skipped";
      summary.skipped.push({ reason: configCheck.code });
      await this.recordMisconfiguration(now, configCheck);
      return this.finishRun(summary);
    }

    let report;
    try {
      report = await this.upstreamStatusPoller.generateWeeklyReport({ now });
    } catch (error) {
      summary.status = "failed";
      summary.errors.push({ message: truncateMessage(error?.message ?? String(error)) });
      await this.recordAttempt(now, {
        success: false,
        failure: {
          code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.REPORT_GENERATION_FAILED,
          message: truncateMessage(error?.message ?? String(error))
        }
      });
      this.logger.warn?.({ err: error }, "bootstrap_self_report.report_generation_failed");
      return this.finishRun(summary);
    }

    try {
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
      await this.recordAttempt(now, { success: true });
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
      // ProviderHttpError carries the provider HTTP status code and a
      // pre-truncated body excerpt; non-HTTP failures (DNS, TLS, abort) land
      // here as plain Errors and we tag them as provider_request_failed.
      const failure = error instanceof ProviderHttpError
        ? {
            code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.PROVIDER_NON_2XX,
            providerStatus: error.providerStatus,
            message: error.shortMessage
          }
        : {
            code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.PROVIDER_REQUEST_FAILED,
            message: truncateMessage(error?.message ?? String(error))
          };
      // Push the sanitized failure message rather than the raw error.message —
      // ProviderHttpError.message interpolates the raw provider body, which
      // can echo auth headers / API keys back through /admin/status.
      summary.errors.push({ message: failure.message });
      await this.recordAttempt(now, { success: false, failure });
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
    return this.describeEmailConfigGap() === undefined;
  }

  // Returns undefined when the email path is fully configured, or a
  // { code, message } describing the precise misconfiguration. Order matches
  // the boot sequence an operator would debug top-down.
  describeEmailConfigGap() {
    if (this.emailSender) return undefined;
    if (!this.resendApiKey) {
      return {
        code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_API_KEY,
        message: "RESEND_API_KEY (or BOOTSTRAP_SELF_REPORT_RESEND_API_KEY) is not set"
      };
    }
    if (!this.from) {
      return {
        code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_FROM_ADDRESS,
        message: "BOOTSTRAP_SELF_REPORT_FROM is not set"
      };
    }
    if (this.to.length === 0) {
      return {
        code: BOOTSTRAP_SELF_REPORT_FAILURE_CODES.MISSING_RECIPIENTS,
        message: "BOOTSTRAP_SELF_REPORT_TO is empty"
      };
    }
    return undefined;
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

  async readPersistedEvidence() {
    if (!this.stateStore?.getServiceState) return undefined;
    try {
      const stored = await this.stateStore.getServiceState(this.stateScope);
      if (!stored) {
        return {
          lastAttemptedAt: undefined,
          lastSuccessfulAt: undefined,
          lastFailureReason: undefined
        };
      }
      return {
        lastAttemptedAt: stored.lastAttemptedAt,
        lastSuccessfulAt: stored.lastSuccessfulAt,
        lastFailureReason: stored.lastFailureReason
      };
    } catch (error) {
      this.logger.warn?.({ err: error }, "bootstrap_self_report.state_read_failed");
      return this.evidence;
    }
  }

  async recordAttempt(now, { success, failure } = {}) {
    const attemptedAt = now.toISOString();
    await this.mergeEvidence(async (current) => {
      const next = { ...current, lastAttemptedAt: attemptedAt };
      if (success) {
        next.lastSuccessfulAt = attemptedAt;
        next.lastFailureReason = undefined;
      } else if (failure) {
        next.lastFailureReason = sanitizeFailureReason(failure);
      }
      return next;
    });
  }

  // Misconfigurations don't count as "attempts that hit the provider", but the
  // operator still needs to see *why* the scheduler isn't sending. We surface
  // them in lastFailureReason and leave lastAttemptedAt / lastSuccessfulAt
  // alone so the freshness check still reflects real network attempts.
  async recordMisconfiguration(now, failure) {
    await this.mergeEvidence(async (current) => ({
      ...current,
      lastFailureReason: sanitizeFailureReason(failure)
    }));
  }

  async mergeEvidence(mutator) {
    // Read-modify-write against either the persisted state or the in-process
    // mirror, so callers like recordAttempt(failure) can update one field
    // without zeroing out the others (e.g. a failed attempt must NOT drop
    // a previously stored lastSuccessfulAt).
    const persisted = await this.readPersistedEvidence();
    const current = persisted ?? this.evidence;
    const next = await mutator({
      lastAttemptedAt: current.lastAttemptedAt,
      lastSuccessfulAt: current.lastSuccessfulAt,
      lastFailureReason: current.lastFailureReason
    });
    this.evidence = {
      lastAttemptedAt: next.lastAttemptedAt,
      lastSuccessfulAt: next.lastSuccessfulAt,
      lastFailureReason: next.lastFailureReason
    };
    if (this.stateStore?.upsertServiceState) {
      try {
        await this.stateStore.upsertServiceState(this.stateScope, this.evidence);
      } catch (error) {
        this.logger.warn?.({ err: error }, "bootstrap_self_report.state_write_failed");
      }
    }
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

// Carries the HTTP status and a pre-truncated body excerpt back to the
// scheduler's catch block so the projection can surface a clean failure
// reason without leaking the full provider response (which can echo the
// authorization header back in error envelopes).
class ProviderHttpError extends Error {
  constructor({ status, message, shortMessage }) {
    super(message);
    this.name = "ProviderHttpError";
    this.providerStatus = status;
    this.shortMessage = shortMessage;
  }
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
    const shortMessage = truncateMessage(extractProviderMessage(body, bodyText));
    throw new ProviderHttpError({
      status: response.status,
      message: `Resend email send failed (${response.status}): ${bodyText}`,
      shortMessage
    });
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

function truncateMessage(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= FAILURE_MESSAGE_MAX_LENGTH) return text;
  return `${text.slice(0, FAILURE_MESSAGE_MAX_LENGTH)}...`;
}

function extractProviderMessage(parsedBody, rawBody) {
  if (parsedBody && typeof parsedBody === "object") {
    if (typeof parsedBody.message === "string" && parsedBody.message) return parsedBody.message;
    if (typeof parsedBody.error === "string" && parsedBody.error) return parsedBody.error;
    if (parsedBody.error && typeof parsedBody.error === "object" && typeof parsedBody.error.message === "string") {
      return parsedBody.error.message;
    }
  }
  return rawBody || "provider returned non-2xx with empty body";
}

function sanitizeFailureReason(failure) {
  if (!failure || typeof failure !== "object") return undefined;
  const result = {
    code: typeof failure.code === "string" ? failure.code : "unknown",
    message: truncateMessage(failure.message ?? "")
  };
  if (typeof failure.providerStatus === "number") {
    result.providerStatus = failure.providerStatus;
  }
  return result;
}
