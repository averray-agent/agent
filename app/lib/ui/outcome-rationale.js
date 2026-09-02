const NEGATIVE_SESSION_STATES = new Set(["rejected", "disputed", "slashed"]);

const SESSION_LABELS = {
  rejected: "Rejected",
  disputed: "Disputed",
  slashed: "Slashed",
};

const DISPUTE_ORIGIN_LABELS = {
  signature: "Signature policy",
  schema: "Schema policy",
  "co-sign-missing": "Co-sign policy",
  "policy-violation": "Policy violation",
  timeout: "Timeout policy",
};

const DISPUTE_DECISION_LABELS = {
  uphold: "Upheld",
  reject: "Rejected",
  split: "Split payout",
  timeout: "Timed out",
};

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberText(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return value.trim();
  }
  return "";
}

export function formatReasonCode(value) {
  const raw = text(value);
  if (!raw) return "";
  return raw
    .replace(/^reason:/iu, "")
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export function isNegativeSessionState(value) {
  return NEGATIVE_SESSION_STATES.has(text(value).toLowerCase());
}

export function policyLabelForVerification({ fallbackPolicy, verification, historyMetadata }) {
  const verifierPolicyVersion =
    numberText(verification.verifierPolicyVersion) ||
    numberText(historyMetadata.verifierPolicyVersion);
  const handler = text(verification.handler, text(historyMetadata.handler, ""));
  if (verifierPolicyVersion) {
    return `${handler ? `${handler.replace(/_/gu, " ")} ` : "Verifier "}policy v${verifierPolicyVersion}`;
  }
  const configVersion =
    numberText(verification.verifierConfigVersion) ||
    numberText(historyMetadata.verifierConfigVersion);
  if (configVersion && handler) {
    return `${handler.replace(/_/gu, " ")} config v${configVersion}`;
  }
  return text(fallbackPolicy, "verifier policy");
}

export function latestNegativeHistory(statusHistory) {
  return [...arrayValue(statusHistory)].reverse().find((entry) => {
    const to = text(entry.to).toLowerCase();
    return NEGATIVE_SESSION_STATES.has(to);
  }) ?? {};
}

export function buildSessionOutcomeRationale({
  state,
  sessionId,
  policy,
  statusHistory,
  verification,
  verificationSummary,
  disputeHref,
  verifierHref,
}) {
  const normalizedState = text(state).toLowerCase();
  if (!NEGATIVE_SESSION_STATES.has(normalizedState)) return null;

  const verificationRecord = {
    ...objectValue(verificationSummary),
    ...objectValue(verification),
  };
  const history = latestNegativeHistory(statusHistory);
  const metadata = objectValue(history.metadata);
  const reasonCode =
    text(metadata.reasonCode) ||
    text(verificationRecord.reasonCode) ||
    text(history.reason) ||
    normalizedState;
  const outcome =
    text(metadata.outcome) ||
    text(verificationRecord.outcome) ||
    normalizedState;
  const disputeId = text(metadata.disputeId);
  const receiptHref = normalizedState === "rejected" ? verifierHref : (disputeHref || verifierHref);
  const receiptLabel = normalizedState === "rejected"
    ? "verification receipt"
    : disputeId
      ? `dispute ${disputeId}`
      : "dispute receipt";
  const reasonLabel = formatReasonCode(reasonCode) || SESSION_LABELS[normalizedState];

  return {
    tone: normalizedState === "disputed" ? "warn" : "bad",
    statusLabel: SESSION_LABELS[normalizedState],
    reason: reasonLabel,
    reasonCode: reasonCode || undefined,
    detail: outcome && outcome !== reasonCode && outcome !== normalizedState
      ? formatReasonCode(outcome)
      : undefined,
    policyLabel: policyLabelForVerification({
      fallbackPolicy: policy,
      verification: verificationRecord,
      historyMetadata: metadata,
    }),
    policyHref: "/policies",
    receiptLabel,
    receiptHref,
    summary: `${SESSION_LABELS[normalizedState]} by ${reasonLabel}`,
    sourceId: sessionId,
  };
}

export function buildDisputeOutcomeRationale({
  state,
  origin,
  openingReceipt,
  sessionId,
  resolution,
  reasonCode,
  reasoningHash,
  metadataURI,
  txHash,
  arbitration,
}) {
  const normalizedState = text(state).toLowerCase();
  const resolved = normalizedState === "resolved";
  const resolutionRecord = objectValue(resolution);
  const decision = text(resolutionRecord.decision);
  const effectiveReasonCode =
    text(resolutionRecord.reasonCode) ||
    text(reasonCode) ||
    (resolved && decision ? decision : text(origin, "policy-violation"));
  const reason = formatReasonCode(effectiveReasonCode) ||
    DISPUTE_DECISION_LABELS[decision] ||
    DISPUTE_ORIGIN_LABELS[text(origin)] ||
    "Policy violation";
  const effectiveReasoningHash = text(resolutionRecord.reasoningHash, text(reasoningHash));
  const effectiveMetadataURI = text(resolutionRecord.metadataURI, text(metadataURI));
  const receiptHref = sessionId
    ? `/session/timeline?sessionId=${encodeURIComponent(sessionId)}`
    : effectiveMetadataURI && /^(?:https?|ipfs):\/\//u.test(effectiveMetadataURI)
      ? effectiveMetadataURI
      : undefined;
  const receiptLabel = resolved
    ? effectiveReasoningHash
      ? `reasoning ${shortHash(effectiveReasoningHash)}`
      : text(txHash)
        ? `tx ${shortHash(txHash)}`
        : "verdict receipt"
    : text(openingReceipt, "opening receipt");
  const policyLabel =
    DISPUTE_ORIGIN_LABELS[text(origin)] ||
    text(objectValue(arbitration).authority?.verdict) ||
    "dispute policy";

  return {
    tone: resolved && decision !== "reject" ? "bad" : "warn",
    statusLabel: resolved ? (DISPUTE_DECISION_LABELS[decision] ?? "Resolved") : "Disputed",
    reason,
    reasonCode: effectiveReasonCode || undefined,
    detail: text(resolutionRecord.rationale),
    policyLabel,
    policyHref: "/policies",
    receiptLabel,
    receiptHref,
    summary: `${resolved ? "Verdict" : "Opened"}: ${reason}`,
    sourceId: sessionId || text(openingReceipt),
  };
}

function shortHash(value) {
  const raw = text(value);
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}
