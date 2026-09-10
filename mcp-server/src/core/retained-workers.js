import { formatBaseUnits } from "./platform-service-helpers.js";
import { wikipediaRevisionKey } from "./paid-source-claim.js";
import { SelfIdentityRegistry } from "./self-identity-registry.js";
import { isHostedCanaryClaimant } from "./claimant-attribution.js";

export const RETAINED_WINDOW_MS = 30 * 86_400_000;

// Claim-time source identity, never today's catalogue, task wording or reissue ID.
// Unknown source shapes are incomplete evidence, not a new source per settlement.
export function retentionSourceKey(job) {
  const source = job?.source;
  const key = (...parts) => parts.every((part) => String(part ?? "").trim())
    ? JSON.stringify([source.type, ...parts.map(String)]) : undefined;
  switch (source?.type) {
    case "wikipedia_article": return wikipediaRevisionKey(job) ? key(wikipediaRevisionKey(job)) : undefined;
    case "github_issue": return key(source.repo?.toLowerCase(), source.issueNumber);
    case "osv_advisory": return key(source.ecosystem, source.packageName, source.vulnerableVersion, source.advisoryId);
    case "open_data_dataset": return key(source.provider, source.datasetId, source.resourceId);
    case "openapi_spec":
    case "standards_spec": return key(source.provider, source.specId);
    default: return undefined;
  }
}

export function approvedSettlement(session) {
  return session?.status === "resolved"
    && (session.verificationSummary?.outcome ?? session.verification?.outcome) === "approved"
    && Number(session.payoutTx?.status) === 1;
}

export function buildRetainedWorkerMetrics(sessions, {
  now = new Date(), selfIdentityRegistry = new SelfIdentityRegistry(), lane = undefined
} = {}) {
  const sources = new Map();
  const seen = new Set();
  let outlay = 0n;
  let omittedSettlementCount = 0;
  let missingSourceCount = 0;
  const nowMs = new Date(now).getTime();
  for (const session of sessions) {
    const job = session?.jobSnapshot?.definition;
    if (lane && job?.lane !== lane) continue;
    const at = Date.parse(session?.resolvedAt ?? "");
    if (!Number.isFinite(at) || at <= nowMs - RETAINED_WINDOW_MS || at > nowMs) continue;
    const wallet = String(session?.wallet ?? "").toLowerCase();
    if (isHostedCanaryClaimant(session) || selfIdentityRegistry.isSelf({ wallet, session })) continue;
    // Rejected/disputed outcomes never make a worker retained. A resolved row
    // without atomic approval/payment pins makes the metric unknown.
    if (session.status !== "resolved") continue;
    const settlementKey = String(session.chainJobId ?? session.jobId ?? session.sessionId);
    if (seen.has(settlementKey)) continue;
    seen.add(settlementKey);
    const settlement = session.payoutTx?.settlement;
    if (!/^0x[0-9a-f]{40}$/u.test(wallet) || !approvedSettlement(session)
      || settlement?.assetSymbol !== "USDC" || !/^(0|[1-9][0-9]*)$/u.test(String(settlement?.workerAmountRaw ?? ""))) {
      omittedSettlementCount += 1;
      continue;
    }
    outlay += BigInt(settlement.workerAmountRaw);
    const source = retentionSourceKey(job);
    if (!source) { missingSourceCount += 1; continue; }
    if (!sources.has(wallet)) sources.set(wallet, new Set());
    sources.get(wallet).add(source);
  }
  const complete = omittedSettlementCount === 0 && missingSourceCount === 0;
  const retained = [...sources.values()].filter((keys) => keys.size >= 2).length;
  const cost = complete && retained > 0 ? outlay / BigInt(retained) : null;
  return {
    retainedExternalWorkers30d: complete ? retained : null,
    externalRewardOutlay30d: {
      raw: omittedSettlementCount ? null : outlay.toString(),
      usdc: omittedSettlementCount ? null : formatBaseUnits(outlay, 6),
      complete: omittedSettlementCount === 0
    },
    costPerRetainedExternalWorker30d: {
      raw: cost?.toString() ?? null,
      usdc: cost === null ? null : formatBaseUnits(cost, 6),
      complete, omittedSettlementCount, missingSourceCount,
      ...(!complete ? { reason: "incomplete_settlement_or_source_evidence" }
        : retained === 0 ? { reason: "no_retained_external_workers" } : {})
    }
  };
}

export function retainedCostStopCondition(metrics) {
  const retained = metrics.retainedExternalWorkers30d;
  if (!metrics.costPerRetainedExternalWorker30d.complete || retained === 0 || retained === null) return null;
  // Compare the exact rational, not the displayed micro-USDC-rounded quotient.
  return BigInt(metrics.externalRewardOutlay30d.raw) > 25_000_000n * BigInt(retained);
}
