import { ConfigError } from "../core/errors.js";
import { isExternalAgentJobId } from "../core/agent-visibility.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const STATE_SCOPE = "first-external-agent-alert";
const SETTLEMENT_TOPICS = Object.freeze([
  "settlement.session_resolved",
  "settlement.session_rejected",
]);

export { isExternalAgentJobId } from "../core/agent-visibility.js";

/**
 * Delivers one durable launch milestone when the first non-canary settlement
 * reaches a terminal state.
 *
 * Delivery evidence is written only after the webhook accepts the request.
 * The in-process queue prevents concurrent settlement events from racing each
 * other, while the Redis-backed service state keeps subsequent deploys from
 * re-arming the alert. Historical sessions are intentionally not scanned:
 * pre-launch smoke settlements predate this milestone and must not be
 * retroactively announced as external participation.
 */
export class FirstExternalAgentAlertService {
  constructor(stateStore, eventBus, {
    enabled = false,
    webhookUrl = undefined,
    environment = "production",
    fetchImpl = fetch,
    logger = console,
    now = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.webhookUrl = normalizeText(webhookUrl);
    this.environment = normalizeText(environment) || "production";
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.running = false;
    this.unsubscribe = undefined;
    this.queue = Promise.resolve();
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.unsubscribe = this.eventBus?.subscribe?.(
      { topics: SETTLEMENT_TOPICS },
      (event) => this.enqueue(() => this.maybeDeliver(event, "live_event"))
    );
  }

  stop() {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async flush() {
    await this.queue;
  }

  async getStatus() {
    const evidence = await this.stateStore?.getServiceState?.(STATE_SCOPE);
    return {
      enabled: this.enabled,
      running: this.running,
      webhookConfigured: Boolean(this.webhookUrl),
      sentAt: evidence?.sentAt,
      firstExternalSettlement: evidence?.firstExternalSettlement,
    };
  }

  enqueue(task) {
    this.queue = this.queue
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn?.(
          { error: error?.message ?? String(error) },
          "first_external_agent_alert.delivery_failed"
        );
      });
    return this.queue;
  }

  async maybeDeliver(event, source) {
    if (!this.enabled || !isExternalAgentJobId(event?.jobId)) return;
    if (await this.hasDelivered()) return;

    const sentAt = this.now().toISOString();
    const evidence = {
      jobId: event.jobId,
      sessionId: event.sessionId,
      wallet: event.wallet,
      outcome: event.data?.outcome,
      status: event.data?.status,
      settlementTopic: event.topic,
      settlementTimestamp: event.timestamp,
      observedVia: source,
    };
    const text = `First external agent settlement on ${this.environment}: ${event.jobId}`;
    const payload = {
      status: "informational",
      text,
      content: text,
      service: "averray-backend",
      environment: this.environment,
      event: "first_external_agent_settled",
      summary: "First external agent settlement",
      timestamp: sentAt,
      ...evidence,
    };

    await postWebhook(this.fetchImpl, this.webhookUrl, payload, this.timeoutMs);
    await this.stateStore?.upsertServiceState?.(STATE_SCOPE, {
      sentAt,
      firstExternalSettlement: evidence,
    });
    this.eventBus?.publish?.({
      id: `first-external-agent-${event.sessionId ?? Date.now()}`,
      topic: "milestone.first_external_agent_settled",
      wallet: event.wallet,
      wallets: event.wallet ? [event.wallet] : [],
      jobId: event.jobId,
      sessionId: event.sessionId,
      timestamp: sentAt,
      correlationId: event.sessionId,
      data: evidence,
    });
    this.logger.info?.(
      { ...evidence, sentAt },
      "first_external_agent_alert.delivered"
    );
  }

  async hasDelivered() {
    const evidence = await this.stateStore?.getServiceState?.(STATE_SCOPE);
    return Boolean(evidence?.sentAt);
  }
}

export function loadFirstExternalAgentAlertConfig(env = process.env) {
  const enabled = parseBooleanEnv(env.FIRST_EXTERNAL_AGENT_ALERT_ENABLED);
  const webhookUrl = normalizeText(env.ALERT_WEBHOOK_URL);
  if (enabled && !webhookUrl) {
    throw new ConfigError(
      "FIRST_EXTERNAL_AGENT_ALERT_ENABLED=true requires ALERT_WEBHOOK_URL."
    );
  }
  return {
    enabled,
    webhookUrl,
    environment: normalizeText(
      env.ALERT_ENVIRONMENT
      ?? env.DEPLOYMENT_PROFILE
      ?? env.AVERRAY_PROFILE
      ?? "production"
    ),
  };
}

async function postWebhook(fetchImpl, webhookUrl, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`alert webhook returned HTTP ${response?.status ?? "unknown"}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBooleanEnv(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}
