import type {
  LifecycleStageState,
  SessionAsset,
  SessionDetail,
  SessionState,
  VerifierMode,
} from "@/components/sessions/types";

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" ? (value as RawRecord) : {};
}

function asArray(value: unknown): RawRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  for (const key of ["items", "sessions", "history"]) {
    if (Array.isArray(record[key])) return record[key].map(asRecord);
  }
  return [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_:]/u)
    .filter(Boolean)
    .slice(0, 4)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function shortAddress(value: unknown): string {
  const raw = text(value);
  if (!raw) return "unknown";
  return raw.length > 12 ? `${raw.slice(0, 6)}...${raw.slice(-4)}` : raw;
}

function initials(value: unknown): string {
  const raw = shortAddress(value);
  if (!raw || raw === "unknown") return "--";
  return raw.replace(/^0x/u, "").slice(0, 2).toUpperCase();
}

function tierLabel(value: unknown): string {
  switch (text(value).toLowerCase()) {
    case "pro":
      return "T2";
    case "elite":
      return "T3";
    default:
      return "T1";
  }
}

function asset(value: unknown): SessionAsset {
  const raw = text(value, "DOT");
  return raw === "USDC" || raw === "vDOT" ? raw : "DOT";
}

function verifierMode(value: unknown): VerifierMode {
  switch (text(value).toLowerCase()) {
    case "deterministic":
      return "deterministic";
    case "human_fallback":
      return "human-llm";
    case "paired-hash":
      return "paired-hash";
    default:
      return "semantic";
  }
}

function state(value: unknown): SessionState {
  switch (text(value).toLowerCase()) {
    case "submitted":
      return "submitted";
    case "resolved":
    case "approved":
      return "approved";
    case "rejected":
    case "expired":
    case "timed_out":
      return "rejected";
    case "disputed":
      return "disputed";
    case "slashed":
      return "slashed";
    case "closed":
    case "settled":
      return "settled";
    default:
      return "active";
  }
}

function amount(value: unknown): string {
  const parsed = numberValue(value);
  return parsed.toLocaleString("en-US", {
    minimumFractionDigits: parsed > 0 && parsed < 10 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function timeLabel(value: unknown): string {
  const raw = text(value);
  if (!raw) return "-";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function ageLabel(value: unknown): string {
  const raw = text(value);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function jobFor(jobs: RawRecord[], jobId: string): RawRecord {
  return jobs.find((job) => text(job.id) === jobId) ?? {};
}

function lifecycle(session: RawRecord) {
  const status = text(session.status, "claimed");
  const entries = asArray(session.statusHistory);
  const order = ["claimed", "submitted", "resolved", "closed"];
  const currentIndex = Math.max(0, order.indexOf(status));

  return order.map((step, index) => {
    const history = entries.find((entry) => text(entry.to) === step);
    const stageState: LifecycleStageState =
      history || index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
    return {
      label: step === "resolved" ? "Verified" : `${step.slice(0, 1).toUpperCase()}${step.slice(1)}`,
      meta: timeLabel(history?.at),
      state: stageState,
      tone: status === "disputed" && index === currentIndex ? "warn" as const : undefined,
    };
  });
}

export function buildSessionDetails(sessionPayload: unknown, jobsPayload: unknown): SessionDetail[] {
  const jobs = asArray(jobsPayload);
  return asArray(sessionPayload).map((session) => {
    const id = text(session.sessionId, text(session.id, "unknown-session"));
    const jobId = text(session.jobId, "unknown-job");
    const job = jobFor(jobs, jobId);
    const rewardAsset = asset(job.rewardAsset);
    const rewardAmount = amount(job.rewardAmount ?? session.claimStake);
    const currentState = state(session.status);
    const updatedAt = session.updatedAt ?? session.resolvedAt ?? session.submittedAt ?? session.claimedAt;
    const verification = asRecord(session.verification);

    return {
      id,
      runRef: jobId,
      job: {
        title: text(job.title, text(job.description, titleFromId(jobId))),
        meta: `${jobId} · ${text(job.category, "work")} · ${tierLabel(job.tier)}`,
      },
      worker: {
        handle: shortAddress(session.wallet),
        address: shortAddress(session.wallet),
        initials: initials(session.wallet),
        tone: "sage",
      },
      state: currentState,
      escrow: { amount: rewardAmount, asset: rewardAsset },
      verifierMode: verifierMode(job.verifierMode),
      age: ageLabel(updatedAt),
      lastEvent: {
        text: verification.outcome
          ? `Verifier ${text(verification.outcome)}`
          : `Session ${text(session.status, "claimed")}`,
        meta: timeLabel(updatedAt),
        tone: currentState === "approved" || currentState === "settled" ? "accent" : currentState === "disputed" ? "warn" : "neutral",
      },
      openedAt: timeLabel(session.claimedAt),
      policy: text(job.outputSchemaRef, "schema pending"),
      receipt: currentState === "approved" || currentState === "settled" ? text(session.sessionId) : undefined,
      lifecycle: lifecycle(session),
      movements: [
        {
          at: timeLabel(session.claimedAt),
          label: "session.claimed",
          from: shortAddress(session.wallet),
          to: "AgentAccountCore",
          amount: `${amount(session.claimStake)} ${rewardAsset}`,
          tx: text(session.chainJobId, "-"),
          tone: "accent",
        },
      ],
      payouts: currentState === "settled"
        ? [
            {
              party: shortAddress(session.wallet),
              role: "worker",
              amount: `${rewardAmount} ${rewardAsset}`,
              at: timeLabel(session.resolvedAt ?? session.closedAt),
              tx: text(session.chainJobId, "-"),
            },
          ]
        : [],
      evidenceHref: `/runs#${encodeURIComponent(jobId)}`,
      verifierHref: `/session/timeline?sessionId=${encodeURIComponent(id)}`,
      disputeHref: currentState === "disputed" ? `/disputes?sessionId=${encodeURIComponent(id)}` : undefined,
    };
  });
}
