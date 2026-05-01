import {
  BADGES,
  tierFor,
  type AgentActiveSession,
  type AgentRecord,
  type AgentSpecialty,
  type AgentState,
  type AgentTier,
} from "@/components/agents/types";

type RawRecord = Record<string, unknown>;

const SPECIALTIES: AgentSpecialty[] = ["coding", "writer-gov", "ops", "gov-review"];

export function extractAgents(data: unknown): AgentRecord[] {
  const rows = Array.isArray(data)
    ? data
    : arrayField(data, "agents") ?? arrayField(data, "items") ?? arrayField(data, "data") ?? [];
  return rows.map(extractAgent).filter((agent): agent is AgentRecord => Boolean(agent));
}

export function extractAgent(data: unknown): AgentRecord | null {
  if (!data || typeof data !== "object") return null;
  const record = data as RawRecord;
  if (isUiAgent(record)) return record as unknown as AgentRecord;

  const walletFull = text(record.wallet, "");
  if (!walletFull) return null;
  const reputation = objectField(record, "reputation");
  const stats = objectField(record, "stats");
  const badgesRaw = Array.isArray(record.badges) ? record.badges : [];
  const score = number(record.reputationScore, reputationScore(reputation));
  const specialty = specialtyFor(record, stats, badgesRaw);
  const badgeIds = badgeIdsFor(badgesRaw, specialty);
  const totalJobs = number(record.totalJobs, number(stats?.approvedCount, 0) + number(stats?.rejectedCount, 0));
  const successRate = record.successRate === null || record.successRate === undefined
    ? number(stats?.completionRate, 0)
    : number(record.successRate, 0);

  const activeSession = activeSessionFor(record);
  const verifiedBadgeCount = badgesRaw.length;
  return {
    handle: text(record.handle, handleForWallet(walletFull)),
    wallet: shortAddress(walletFull),
    walletFull,
    tier: tierFrom(record.tier, score),
    score,
    sparkline: sparkline(score),
    badges: badgeIds,
    badgeDates: badgeDatesFor(badgesRaw, badgeIds),
    specialty,
    stake: stakeFor(record),
    activity: activityFor(record, badgesRaw, totalJobs, activeSession),
    state: stateFor(record, totalJobs, activeSession),
    ...(activeSession ? { activeSession } : {}),
    hasVerifiedBadges: verifiedBadgeCount > 0,
    recentRuns: recentRunsFor(badgesRaw),
    slashes: slashEvents(record.slashEvents),
  };
}

function isUiAgent(record: RawRecord): boolean {
  return Boolean(record.walletFull && record.stake && record.activity && Array.isArray(record.recentRuns));
}

function reputationScore(reputation: RawRecord | null): number {
  return number(reputation?.skill, 0) + number(reputation?.reliability, 0) + number(reputation?.economic, 0);
}

function tierFrom(value: unknown, score: number): AgentTier {
  const raw = text(value, "").toLowerCase();
  if (raw === "t3" || raw === "expert" || raw === "master") return "T3";
  if (raw === "t2" || raw === "journeyman") return "T2";
  if (raw === "t1" || raw === "apprentice") return "T1";
  return tierFor(score);
}

function specialtyFor(record: RawRecord, stats: RawRecord | null, badges: unknown[]): AgentSpecialty {
  const direct = normalizeSpecialty(record.specialty);
  if (direct) return direct;
  const preferred = arrayField(stats, "preferredCategories")?.[0];
  if (preferred && typeof preferred === "object") {
    const fromPreferred = normalizeSpecialty((preferred as RawRecord).category);
    if (fromPreferred) return fromPreferred;
  }
  for (const badge of badges) {
    if (!badge || typeof badge !== "object") continue;
    const category = normalizeSpecialty((badge as RawRecord).category);
    if (category) return category;
  }
  return "coding";
}

function normalizeSpecialty(value: unknown): AgentSpecialty | null {
  const raw = text(value, "").toLowerCase();
  if (raw === "writer" || raw === "writing") return "writer-gov";
  if (raw === "governance" || raw === "gov") return "gov-review";
  if (raw === "operations" || raw === "xcm") return "ops";
  return SPECIALTIES.includes(raw as AgentSpecialty) ? (raw as AgentSpecialty) : null;
}

function badgeIdsFor(badges: unknown[], specialty: AgentSpecialty): string[] {
  const ids = badges.slice(0, 5).reduce<string[]>((items, badge) => {
    if (!badge || typeof badge !== "object") return items;
    const record = badge as RawRecord;
    const category = normalizeSpecialty(record.category) ?? specialty;
    const level = number(record.level, 1);
    const id =
      category === "coding" ? (level >= 3 ? "code3" : level >= 2 ? "code2" : "code")
      : category === "writer-gov" ? (level >= 2 ? "write2" : "write")
      : category === "ops" ? (level >= 2 ? "ops2" : "ops")
      : category === "gov-review" ? (level >= 2 ? "gov2" : "gov")
      : null;
    if (id && BADGES[id]) items.push(id);
    return items;
  }, []);
  const fallback = specialty === "coding" ? "code" : specialty === "writer-gov" ? "write" : specialty === "ops" ? "ops" : "gov";
  return Array.from(new Set(ids.length ? ids : [fallback]));
}

function badgeDatesFor(badges: unknown[], ids: string[]): Record<string, string> {
  const dates: Record<string, string> = {};
  ids.forEach((id, index) => {
    const badge = badges[index] && typeof badges[index] === "object" ? (badges[index] as RawRecord) : {};
    dates[id] = dateOnly(text(badge.completedAt, ""));
  });
  return dates;
}

function stakeFor(record: RawRecord): AgentRecord["stake"] {
  const deposited = number(record.activeStake, 0);
  const locked = Math.min(deposited, number(record.lockedStake, 0));
  const slashed = Array.isArray(record.slashEvents) ? record.slashEvents.length : 0;
  return {
    deposited,
    locked,
    available: Math.max(0, deposited - locked),
    slashed30: slashed,
  };
}

function activityFor(
  record: RawRecord,
  badges: unknown[],
  totalJobs: number,
  activeSession: AgentActiveSession | undefined
): AgentRecord["activity"] {
  // Priority: live claim > most recent badge > fallback to the
  // "no runs yet" empty-state copy.
  if (activeSession) {
    const verb =
      activeSession.status === "claimed"
        ? "Claimed"
        : activeSession.status === "working"
          ? "Working on"
          : activeSession.status === "submitted"
            ? "Submitted"
            : "Disputed";
    return {
      msg: `${verb} ${activeSession.jobId}`,
      ref: activeSession.jobId,
      when: relativeTime(activeSession.lastEventAt ?? record.fetchedAt),
    };
  }
  const latest = badges[0] && typeof badges[0] === "object" ? (badges[0] as RawRecord) : null;
  const jobId = text(latest?.jobId, "");
  if (jobId) {
    return {
      msg: `Earned badge on ${jobId}`,
      ref: jobId,
      when: relativeTime(latest?.completedAt),
    };
  }
  return {
    msg: totalJobs ? `${totalJobs} completed jobs indexed` : "Waiting for first verified run",
    ref: totalJobs ? `${totalJobs}` : "first run",
    when: relativeTime(record.fetchedAt),
  };
}

function stateFor(
  record: RawRecord,
  totalJobs: number,
  activeSession: AgentActiveSession | undefined
): AgentState {
  if (Array.isArray(record.slashEvents) && record.slashEvents.length) return "slashed";
  if (activeSession) return activeSession.status;
  return totalJobs > 0 ? "active" : "idle";
}

function activeSessionFor(record: RawRecord): AgentActiveSession | undefined {
  // The backend may attach an `activeSession` block directly on the agent
  // payload, or split it across `currentSession` / `currentJob`. Tolerate
  // either shape — if neither is present we just leave the agent in
  // `idle`/`active` and the directory + drawer fall back to history.
  const block =
    objectField(record, "activeSession") ??
    objectField(record, "currentSession") ??
    null;
  if (!block) return undefined;
  const runId = text(block.runId, "");
  const jobId = text(block.jobId, "");
  const sessionId = text(block.sessionId, "");
  if (!runId || !jobId || !sessionId) return undefined;
  const status = activeStatus(block.status);
  if (!status) return undefined;
  return {
    runId,
    jobId,
    sessionId,
    status,
    ...(text(block.title) ? { title: text(block.title) } : {}),
    ...(text(block.deadlineAt) ? { deadlineAt: text(block.deadlineAt) } : {}),
    ...(text(block.lastEventAt) ? { lastEventAt: text(block.lastEventAt) } : {}),
    ...(text(block.lastEvent) ? { lastEvent: text(block.lastEvent) } : {}),
  };
}

function activeStatus(value: unknown): AgentActiveSession["status"] | null {
  const raw = text(value, "").toLowerCase();
  if (raw === "claimed") return "claimed";
  if (raw === "working" || raw === "in_progress") return "working";
  if (raw === "submitted" || raw === "pending" || raw === "pending_verification") return "submitted";
  if (raw === "disputed" || raw === "rejected") return "disputed";
  return null;
}

function recentRunsFor(badges: unknown[]): AgentRecord["recentRuns"] {
  return badges.slice(0, 8).map((badge, index) => {
    const record = badge && typeof badge === "object" ? (badge as RawRecord) : {};
    const jobId = text(record.jobId, `run-${index + 1}`);
    return {
      id: jobId,
      title: titleFromId(jobId),
      receipt: text(record.sessionId, "-"),
      state: "Verified",
    };
  });
}

function slashEvents(value: unknown): AgentRecord["slashes"] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const record = entry && typeof entry === "object" ? (entry as RawRecord) : {};
    return {
      when: text(record.when, text(record.at, "-")),
      amount: text(record.amount, "0 DOT"),
      reason: text(record.reason, "Slash recorded"),
      ref: text(record.ref, `slash-${index + 1}`),
    };
  });
}

function sparkline(score: number): number[] {
  const base = Math.max(0, score - 32);
  return Array.from({ length: 14 }, (_, index) => Math.max(0, base + Math.round(index * 2.4)));
}

function handleForWallet(wallet: string): string {
  const raw = wallet.toLowerCase().replace(/^0x/u, "");
  return `agent-${raw.slice(0, 4)}-${raw.slice(-4)}`;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_:]/u)
    .filter(Boolean)
    .slice(0, 5)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function relativeTime(value: unknown): string {
  const parsed = Date.parse(text(value, ""));
  if (!Number.isFinite(parsed)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function dateOnly(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "-";
}

function shortAddress(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectField(value: unknown, key: string): RawRecord | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as RawRecord)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? (field as RawRecord) : null;
}

function arrayField(value: unknown, key: string): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as RawRecord)[key];
  return Array.isArray(field) ? field : null;
}
