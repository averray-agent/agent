/**
 * Map raw SSE stream records into PlatformPulse rows. Pure and
 * defensive: event payload shapes vary by topic, so every field is
 * best-effort — but the topic and receive time are always real.
 */

const WARN_TOPICS = new Set([
  "escrow.dispute_opened",
  "escrow.job_rejected",
  "escrow.auto_resolved_on_timeout",
  "account.job_stake_slashed",
  "reputation.slashed",
  "system.provider_error",
  "system.listener_error",
]);

const ACCENT_TOPICS = new Set([
  "verification.resolved",
  "reputation.badge_minted",
  "escrow.job_funded",
  "escrow.job_closed",
  "escrow.dispute_resolved",
  "account.job_stake_released",
]);

/** @param {string} topic */
export function pulseKindForTopic(topic) {
  if (topic.startsWith("account.")) return "stake";
  if (topic.startsWith("reputation.")) return "identity";
  return "runs";
}

/** @param {string} topic */
export function pulseToneForTopic(topic) {
  if (WARN_TOPICS.has(topic)) return "warn";
  if (ACCENT_TOPICS.has(topic)) return "accent";
  if (topic.startsWith("session.")) return "blue";
  return "neutral";
}

export function shortWallet(value) {
  const wallet = typeof value === "string" ? value.trim() : "";
  if (!/^0x[0-9a-fA-F]{6,}$/u.test(wallet)) return wallet || "—";
  return `${wallet.slice(0, 8)}…${wallet.slice(-4)}`;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textOf(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * @param {Array<{topic: string, data: unknown, id?: string, at: number}>} records
 * @returns pulse rows, newest first
 */
export function buildPulseEvents(records) {
  return (records ?? []).map((raw, index) => {
    const topic = String(raw?.topic ?? "unknown");
    const [namespace, ...rest] = topic.split(".");
    const data = record(raw?.data);
    const wallet =
      textOf(data.wallet) || textOf(data.worker) || textOf(data.claimedBy) || textOf(data.account);
    const ref =
      textOf(data.jobId) || textOf(data.sessionId) || textOf(data.disputeId) || textOf(data.id);
    return {
      id: textOf(raw?.id) || `${topic}-${raw?.at ?? index}-${index}`,
      kind: pulseKindForTopic(topic),
      tone: pulseToneForTopic(topic),
      topicNamespace: namespace || "event",
      topicAction: rest.join(".") || topic,
      address: shortWallet(wallet),
      message: ref ? `ref ${ref}` : "event received",
      time: formatUtcTime(raw?.at),
    };
  });
}

function formatUtcTime(at) {
  const parsed = Number(at);
  if (!Number.isFinite(parsed)) return "—";
  return `${new Date(parsed).toISOString().slice(11, 19)} UTC`;
}
