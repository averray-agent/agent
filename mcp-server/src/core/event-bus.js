const DEFAULT_EVENT_BUFFER_SIZE = 500;

export class EventBus {
  constructor({ bufferSize = DEFAULT_EVENT_BUFFER_SIZE, eventStore = undefined, logger = console } = {}) {
    this.bufferSize = bufferSize;
    this.eventStore = eventStore;
    this.logger = logger;
    this.buffer = [];
    this.subscribers = new Set();
    this.persistQueue = Promise.resolve();
  }

  subscribe(filter, handler) {
    const subscription = {
      filter: normalizeFilter(filter),
      handler
    };
    this.subscribers.add(subscription);
    return () => {
      this.subscribers.delete(subscription);
    };
  }

  publish(event) {
    const normalized = normalizeEvent(event);
    this.buffer.push(normalized);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
    this.queuePersist(normalized);

    for (const subscription of this.subscribers) {
      if (matchesFilter(normalized, subscription.filter)) {
        subscription.handler(normalized);
      }
    }

    return normalized;
  }

  queuePersist(event) {
    if (!this.eventStore?.appendEventLog) {
      return;
    }

    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.eventStore.appendEventLog(event))
      .catch((error) => {
        this.logger?.warn?.(
          { eventId: event.id, topic: event.topic, error: error?.message ?? String(error) },
          "event_bus.persist_failed"
        );
      });
  }

  async flush() {
    await this.persistQueue;
  }

  replay(filter = {}, lastEventId = undefined) {
    const normalizedFilter = normalizeFilter(filter);
    if (!lastEventId) {
      return {
        events: this.buffer.filter((event) => matchesFilter(event, normalizedFilter)),
        gap: false
      };
    }

    const cursorIndex = this.buffer.findIndex((event) => event.id === lastEventId);
    if (cursorIndex === -1) {
      return {
        events: this.buffer.filter((event) => matchesFilter(event, normalizedFilter)),
        gap: this.buffer.length > 0
      };
    }

    return {
      events: this.buffer.slice(cursorIndex + 1).filter((event) => matchesFilter(event, normalizedFilter)),
      gap: false
    };
  }

  async replayDurable(filter = {}, lastEventId = undefined, { limit = this.bufferSize } = {}) {
    const normalizedFilter = normalizeFilter(filter);
    if (!this.eventStore?.listEventLog) {
      return this.replay(normalizedFilter, lastEventId);
    }

    const stored = await this.eventStore.listEventLog({
      ...normalizedFilter,
      lastEventId,
      limit
    });
    const live = this.replay(normalizedFilter, lastEventId);
    const byId = new Map();
    for (const event of [...(stored.events ?? []), ...live.events]) {
      byId.set(event.id, event);
    }
    const events = [...byId.values()]
      .sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
      .slice(-Math.max(limit, 0));

    return {
      events,
      gap: Boolean(stored.gap)
    };
  }
}

function normalizeFilter(filter = {}) {
  return {
    wallet: filter.wallet?.trim() || undefined,
    jobId: filter.jobId?.trim() || undefined,
    sessionId: filter.sessionId?.trim() || undefined,
    correlationId: filter.correlationId?.trim() || undefined,
    topics: normalizeTopics(filter.topics ?? filter.topic),
    sources: normalizeTopics(filter.sources ?? filter.source),
    phases: normalizeTopics(filter.phases ?? filter.phase),
    severities: normalizeTopics(filter.severities ?? filter.severity)
  };
}

function normalizeEvent(event) {
  const topic = normalizeText(event.topic);
  const taxonomy = classifyEventTopic(topic, event.data);
  const wallets = new Set(
    [event.wallet, ...(Array.isArray(event.wallets) ? event.wallets : [])]
      .map((value) => normalizeText(value))
      .filter(Boolean)
  );
  const jobId = normalizeText(event.jobId);
  const sessionId = normalizeText(event.sessionId);
  const timestamp = normalizeText(event.timestamp) || new Date().toISOString();

  return {
    id: normalizeText(event.id) || `event-${Date.parse(timestamp) || Date.now()}-${nextEventSequence()}`,
    topic,
    type: normalizeText(event.type) || "event_bus",
    source: normalizeText(event.source) || taxonomy.source,
    phase: normalizeText(event.phase) || taxonomy.phase,
    severity: normalizeSeverity(event.severity) || taxonomy.severity,
    correlationId: normalizeText(event.correlationId) || sessionId || jobId || undefined,
    wallet: normalizeText(event.wallet) || undefined,
    wallets: [...wallets],
    jobId: jobId || undefined,
    sessionId: sessionId || undefined,
    blockNumber: event.blockNumber ?? null,
    txHash: event.txHash ?? null,
    timestamp,
    data: event.data ?? {}
  };
}

function classifyEventTopic(topic, data = {}) {
  if (topic.startsWith("escrow.")) {
    return {
      source: "chain",
      phase: escrowPhase(topic),
      severity: escrowSeverity(topic)
    };
  }
  if (topic.startsWith("account.")) {
    return {
      source: "chain",
      phase: accountPhase(topic),
      severity: topic.includes("slashed") ? "warn" : "info"
    };
  }
  if (topic.startsWith("reputation.")) {
    return {
      source: "chain",
      phase: "reputation",
      severity: topic.includes("slashed") ? "warn" : "info"
    };
  }
  if (topic.startsWith("content.")) {
    return {
      source: "chain",
      phase: "content",
      severity: "info"
    };
  }
  if (topic.startsWith("xcm.")) {
    return {
      source: "settlement",
      phase: "settlement",
      severity: xcmSeverity(topic, data)
    };
  }
  if (topic.startsWith("funding.")) {
    return {
      source: "settlement",
      phase: "funding",
      severity: fundingSeverity(topic, data)
    };
  }
  if (topic.startsWith("settlement.")) {
    return {
      source: "settlement",
      phase: "settlement",
      severity: settlementSeverity(topic, data)
    };
  }
  if (topic.startsWith("dispute.")) {
    return {
      source: "settlement",
      phase: "dispute",
      severity: disputeSeverity(topic, data)
    };
  }
  if (topic.startsWith("verification.")) {
    return {
      source: "verification",
      phase: "verification",
      severity: verificationSeverity(data)
    };
  }
  if (topic.startsWith("recurring.")) {
    return {
      source: "schedule",
      phase: "recurring",
      severity: topic.includes("failed") ? "error" : "info"
    };
  }
  if (topic.startsWith("jobs.ingest.")) {
    return {
      source: "ingestion",
      phase: "ingestion",
      severity: "info"
    };
  }
  if (topic.startsWith("system.")) {
    return {
      source: "system",
      phase: "system",
      severity: topic.includes("error") || topic.includes("failed") ? "error" : "warn"
    };
  }
  if (topic.startsWith("session.")) {
    return {
      source: "state",
      phase: "session",
      severity: sessionSeverity(data)
    };
  }
  if (topic.startsWith("policy.")) {
    return {
      source: "governance",
      phase: "governance",
      severity: "info"
    };
  }
  if (topic.startsWith("capability.")) {
    return {
      source: "governance",
      phase: "capability",
      // Revoke is the load-bearing trust-removal signal; treat as a
      // higher-attention event than the routine grant/list flow.
      severity: topic === "capability.revoke" ? "warn" : "info"
    };
  }
  if (topic.startsWith("service-token.")) {
    return {
      source: "governance",
      phase: "service_token",
      // Same shape as capability.revoke: revocation is the signal an
      // operator wants to see in the timeline immediately.
      severity: topic === "service-token.revoke" ? "warn" : "info"
    };
  }
  return {
    source: "event_bus",
    phase: topic || "event",
    severity: "info"
  };
}

function escrowPhase(topic) {
  if (topic === "escrow.job_funded") return "funding";
  if (topic === "escrow.dispute_opened" || topic === "escrow.dispute_resolved") return "dispute";
  if (
    topic === "escrow.job_closed" ||
    topic === "escrow.job_rejected" ||
    topic === "escrow.auto_resolved_on_timeout"
  ) {
    return "settlement";
  }
  return "execution";
}

function escrowSeverity(topic) {
  if (topic === "escrow.job_rejected") return "error";
  if (topic === "escrow.dispute_opened") return "warn";
  return "info";
}

function accountPhase(topic) {
  if (topic === "account.job_stake_locked") return "funding";
  if (topic === "account.job_stake_slashed" || topic === "account.claim_fee_slashed") return "dispute";
  return "settlement";
}

function xcmSeverity(topic, data) {
  const status = normalizeText(data?.statusLabel) || normalizeText(data?.status);
  if (topic.includes("failed") || status.toLowerCase().includes("failed")) return "error";
  return "info";
}

function fundingSeverity(topic, data) {
  const status = normalizeText(data?.status);
  if (topic.includes("failed") || status === "failed") return "error";
  return "info";
}

function settlementSeverity(topic, data) {
  const status = normalizeText(data?.status);
  const outcome = normalizeText(data?.outcome);
  if (topic.includes("failed") || status === "rejected" || outcome === "rejected") return "error";
  if (status === "disputed" || outcome === "disputed") return "warn";
  return "info";
}

function disputeSeverity(topic, data) {
  const verdict = normalizeText(data?.verdict);
  const status = normalizeText(data?.status);
  if (topic.includes("failed") || status === "failed") return "error";
  if (topic.includes("opened") || verdict === "upheld" || verdict === "split") return "warn";
  return "info";
}

function verificationSeverity(data) {
  const outcome = normalizeText(data?.outcome);
  const status = normalizeText(data?.status);
  if (outcome === "rejected" || status === "rejected") return "error";
  if (outcome === "disputed" || status === "disputed") return "warn";
  return "info";
}

function sessionSeverity(data) {
  const status = normalizeText(data?.status);
  if (["failed", "rejected", "slashed"].includes(status)) return "error";
  if (status === "disputed") return "warn";
  return "info";
}

function normalizeSeverity(value) {
  const normalized = normalizeText(value);
  return normalized === "info" || normalized === "warn" || normalized === "error"
    ? normalized
    : undefined;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTopics(topics) {
  if (!topics) return [];
  if (Array.isArray(topics)) {
    return topics.map((topic) => String(topic).trim()).filter(Boolean);
  }
  return String(topics)
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
}

export function matchesFilter(event, filter = {}) {
  const topics = normalizeTopics(filter.topics);
  if (topics.length && !topics.includes(event.topic)) {
    return false;
  }

  const sources = normalizeTopics(filter.sources);
  if (sources.length && !sources.includes(event.source)) {
    return false;
  }

  const phases = normalizeTopics(filter.phases);
  if (phases.length && !phases.includes(event.phase)) {
    return false;
  }

  const severities = normalizeTopics(filter.severities);
  if (severities.length && !severities.includes(event.severity)) {
    return false;
  }

  if (filter.jobId && event.jobId !== filter.jobId) {
    return false;
  }

  if (filter.sessionId && event.sessionId !== filter.sessionId) {
    return false;
  }

  if (filter.correlationId && event.correlationId !== filter.correlationId) {
    return false;
  }

  if (filter.wallet) {
    const wallets = new Set([event.wallet, ...(event.wallets ?? [])].filter(Boolean));
    if (!wallets.has(filter.wallet)) {
      return false;
    }
  }

  return true;
}

let eventSequence = 0;

function nextEventSequence() {
  eventSequence = (eventSequence + 1) % Number.MAX_SAFE_INTEGER;
  return eventSequence;
}
