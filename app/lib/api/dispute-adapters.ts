import type {
  DecisionKind,
  Dispute,
  DisputeOrigin,
  DisputeParty,
  DisputeSeverity,
  DisputeState,
  EvidenceRow,
  ReleaseDestination,
} from "@/components/disputes/types";

const DEFAULT_REVIEWER = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";

export function extractDisputeList(data: unknown): Dispute[] {
  const rows = Array.isArray(data)
    ? data
    : arrayField(data, "disputes") ?? arrayField(data, "items") ?? arrayField(data, "data") ?? [];
  return rows.map(extractDispute).filter((dispute): dispute is Dispute => Boolean(dispute));
}

export function extractDispute(data: unknown): Dispute | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const id = text(record.id, "");
  if (!id) return null;

  if (isUiDispute(record)) return record as unknown as Dispute;

  const sessionId = text(record.sessionId, text(record.runRef, id));
  const evidence = objectField(record, "evidence");
  const before = objectField(evidence, "before") ?? {};
  const after = objectField(evidence, "after") ?? {};
  const openedAt = text(record.openedAt, new Date().toISOString());
  const windowEndsAt = text(record.windowEndsAt, "");
  const windowSeconds = secondsBetween(openedAt, windowEndsAt) ?? 72 * 60 * 60;
  const windowElapsed = elapsedSeconds(openedAt, windowSeconds);
  const status = text(record.status, text(record.state, "open"));
  const verdict = verdictToDecision(record.verdict);
  const release = objectField(record, "release");
  const releaseDestination = releaseToDestination(release, verdict);
  const stakeFrozen = number(record.stakedAmount, number(record.stakeFrozen, 0));
  const workerPayout = optionalNumber(record.workerPayout);
  const remainingPayout = optionalNumber(record.remainingPayout);
  const txHash = text(record.txHash, "");
  const chainStatus = text(record.chainStatus, "");
  const reasonCode = text(record.reasonCode, "");
  const metadataURI = text(record.metadataURI, "");
  const reasoningHash = text(record.reasoningHash, "");

  return {
    id,
    runRef: text(record.runRef, sessionId),
    openingReceipt: text(record.openingReceipt, id),
    summary: text(record.summary, disputeSummary(record, sessionId)),
    origin: originFor(record),
    severity: severityFor(record, stakeFrozen),
    state: stateFor(status, verdict),
    opener: party(record.claimant, "claimant", "blue"),
    respondent: party(record.respondent, "respondent", "clay"),
    reviewer: party(record.reviewer ?? DEFAULT_REVIEWER, "operator-primary", "sage"),
    stakeFrozen,
    workerPayout,
    remainingPayout,
    reasonCode: reasonCode || undefined,
    reasoningHash: reasoningHash || undefined,
    metadataURI: metadataURI || undefined,
    txHash: txHash || undefined,
    chainStatus: chainStatus || undefined,
    stakeBreakdown: stakeBreakdown(stakeFrozen),
    openedAt: displayDate(openedAt),
    windowSeconds,
    windowElapsed,
    evidence: evidenceRows(before, after),
    workerPayload: prettyJson(after),
    expectedPayload: prettyJson(before),
    timeline: timeline(record.timeline),
    resolution: verdict
      ? {
          decision: verdict,
          destination: releaseDestination,
          rationale: text(record.rationale, text(record.reason, "Resolved by operator verdict.")),
          at: displayDate(text(release?.releasedAt, text(record.decidedAt, new Date().toISOString()))),
          signer: party(record.decidedBy ?? release?.releasedBy ?? record.reviewer ?? DEFAULT_REVIEWER, "operator-primary", "sage"),
          reasonCode: reasonCode || undefined,
          workerPayout,
          txHash: txHash || undefined,
          chainStatus: chainStatus || undefined,
          metadataURI: metadataURI || undefined,
          reasoningHash: reasoningHash || undefined,
        }
      : undefined,
  };
}

function isUiDispute(record: Record<string, unknown>): boolean {
  return Boolean(
    record.runRef &&
      record.openingReceipt &&
      record.opener &&
      record.respondent &&
      record.reviewer &&
      Array.isArray(record.evidence)
  );
}

function disputeSummary(record: Record<string, unknown>, sessionId: string): string {
  const jobTitle = text(objectField(objectField(record, "evidence"), "before")?.jobTitle, "");
  if (jobTitle) {
    return `${jobTitle} on ${sessionId} is contested; stake remains frozen pending operator review.`;
  }
  return `${sessionId} is contested; stake remains frozen pending operator review.`;
}

function stateFor(status: string, verdict: DecisionKind | null): DisputeState {
  const normalized = status.toLowerCase().replace(/_/gu, "-");
  if (verdict || normalized === "resolved" || normalized === "closed") return "resolved";
  if (normalized === "awaiting-evidence") return "awaiting-evidence";
  if (normalized === "under-review" || normalized === "review") return "under-review";
  if (normalized === "escalated") return "escalated";
  return "open";
}

function originFor(record: Record<string, unknown>): DisputeOrigin {
  const hay = prettyJson(record).toLowerCase();
  if (hay.includes("signature")) return "signature";
  if (hay.includes("schema")) return "schema";
  if (hay.includes("co-sign") || hay.includes("cosign") || hay.includes("second signer")) {
    return "co-sign-missing";
  }
  if (hay.includes("timeout") || hay.includes("window")) return "timeout";
  return "policy-violation";
}

function severityFor(record: Record<string, unknown>, stake: number): DisputeSeverity {
  const raw = text(record.severity, "").toLowerCase();
  if (raw === "advisory" || raw === "gating" || raw === "hard-stop") return raw;
  if (stake >= 25) return "hard-stop";
  if (stake > 0) return "gating";
  return "advisory";
}

function party(value: unknown, fallbackHandle: string, tone: DisputeParty["tone"]): DisputeParty {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const handle = text(record.handle, fallbackHandle);
    const address = text(record.address, text(record.wallet, shortAddress(handle)));
    return {
      handle,
      address: shortAddress(address),
      initials: text(record.initials, initials(handle)),
      tone: partyTone(record.tone, tone),
    };
  }
  const address = text(value, fallbackHandle);
  return {
    handle: address.startsWith("0x") ? shortAddress(address) : address,
    address: shortAddress(address),
    initials: initials(address),
    tone,
  };
}

function partyTone(value: unknown, fallback: DisputeParty["tone"]): DisputeParty["tone"] {
  if (value === "sage" || value === "ink" || value === "clay" || value === "blue" || value === "muted") {
    return value;
  }
  return fallback;
}

function evidenceRows(before: Record<string, unknown>, after: Record<string, unknown>): EvidenceRow[] {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  if (!keys.length) {
    return [
      {
        label: "payload",
        worker: "submitted",
        expected: "available",
        match: "warn",
        note: "Raw dispute evidence is shown in the payload columns.",
      },
    ];
  }
  return keys.slice(0, 8).map((key) => {
    const worker = compactValue(after[key]);
    const expected = compactValue(before[key]);
    return {
      label: key,
      worker,
      expected,
      match: worker === expected ? "ok" : "fail",
      note: worker === expected ? undefined : "worker payload differs from expected verifier context",
    };
  });
}

function timeline(value: unknown): Dispute["timeline"] {
  if (!Array.isArray(value)) return [];
  return value.reduce<Dispute["timeline"]>((events, entry, index) => {
    if (!entry || typeof entry !== "object") return events;
    const record = entry as Record<string, unknown>;
    const action = text(record.action, `event_${index + 1}`);
    events.push({
      at: displayDate(text(record.at, text(record.timestamp, new Date().toISOString()))),
      label: action.replace(/_/gu, "."),
      body: timelineBody(record, action),
      tone: timelineTone(action),
    });
    return events;
  }, []);
}

function timelineBody(record: Record<string, unknown>, action: string): string {
  const actor = text(record.actor, "system");
  const data = objectField(record, "data");
  const reason = text(data?.reason, "");
  if (reason) return `${actor} recorded ${reason}.`;
  const reasonCode = text(data?.reasonCode, "");
  const txHash = text(data?.txHash, "");
  if (action.includes("verdict") && reasonCode) {
    return `${actor} recorded ${reasonCode}${txHash ? ` · ${shortAddress(txHash)}` : ""}.`;
  }
  return `${actor} recorded ${action.replace(/_/gu, " ")}.`;
}

function timelineTone(action: string): Dispute["timeline"][number]["tone"] {
  if (action.includes("release") || action.includes("resolved")) return "accent";
  if (action.includes("verdict")) return "bad";
  if (action.includes("locked") || action.includes("dispute")) return "warn";
  return "neutral";
}

function stakeBreakdown(total: number): Dispute["stakeBreakdown"] {
  if (total <= 0) return { worker: 0, verifier: 0, treasury: 0 };
  return {
    worker: roundDot(total * 0.68),
    verifier: roundDot(total * 0.22),
    treasury: roundDot(total * 0.1),
  };
}

export function decisionToVerdict(decision: DecisionKind): "upheld" | "dismissed" | "split" {
  if (decision === "uphold") return "upheld";
  if (decision === "reject") return "dismissed";
  return "split";
}

function verdictToDecision(value: unknown): DecisionKind | null {
  if (value === "upheld" || value === "uphold") return "uphold";
  if (value === "dismissed" || value === "reject" || value === "rejected") return "reject";
  if (value === "split" || value === "request-more") return "request-more";
  return null;
}

function releaseToDestination(value: Record<string, unknown> | null, decision: DecisionKind | null): ReleaseDestination {
  const action = text(value?.action, "").toLowerCase();
  if (action.includes("verifier")) return "pay-verifier";
  if (action.includes("return") || action.includes("depositor")) return "return-to-depositor";
  if (action.includes("slash") || action.includes("treasury")) return "slash-to-treasury";
  if (decision === "reject") return "return-to-depositor";
  return "slash-to-treasury";
}

function displayDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const date = new Date(parsed);
  const month = date.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const day = date.toLocaleString("en", { day: "numeric", timeZone: "UTC" });
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day} · ${hh}:${mm} UTC`;
}

function secondsBetween(start: string, end: string): number | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

function elapsedSeconds(start: string, total: number): number {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return 0;
  return Math.min(total, Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function compactValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : null;
}

function arrayField(value: unknown, key: string): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : null;
}

function shortAddress(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function initials(value: string): string {
  const cleaned = value.replace(/^0x/u, "");
  return (cleaned.match(/[a-z0-9]/giu)?.join("") ?? "--").slice(0, 2).toUpperCase();
}

function roundDot(value: number): number {
  return Math.round(value * 100) / 100;
}
