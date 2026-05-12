const DEFAULT_EVENT_BUFFER_SIZE = 500;

export class EventBus {
  constructor({ bufferSize = DEFAULT_EVENT_BUFFER_SIZE } = {}) {
    this.bufferSize = bufferSize;
    this.buffer = [];
    this.subscribers = new Set();
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

    for (const subscription of this.subscribers) {
      if (matchesFilter(normalized, subscription.filter)) {
        subscription.handler(normalized);
      }
    }

    return normalized;
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
}

function normalizeFilter(filter = {}) {
  return {
    wallet: filter.wallet?.trim() || undefined,
    jobId: filter.jobId?.trim() || undefined,
    sessionId: filter.sessionId?.trim() || undefined,
    topics: normalizeTopics(filter.topics)
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

  return {
    id: normalizeText(event.id) || undefined,
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
    timestamp: event.timestamp ?? new Date().toISOString(),
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

  if (filter.jobId && event.jobId !== filter.jobId) {
    return false;
  }

  if (filter.sessionId && event.sessionId !== filter.sessionId) {
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
