import { decimalsForAssetSymbol } from "./assets.js";
import { hashCanonicalContent } from "./canonical-content.js";
import { ValidationError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { claimExpiresAt } from "./claim-state.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";
import { buildRunReceipt } from "./run-receipt.js";
import { hashSubmission } from "./submission.js";
import { verificationDepthForJob } from "./verification-depth.js";

export const WORK_RECEIPT_SCHEMA_VERSION = "averray.work-receipt.v1";
export const WORK_RECEIPT_SITE_ORIGIN = "https://averray.com";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u;

/**
 * Promote the existing run receipt into the portable work receipt. The run
 * builder remains the compatibility authority for verdict, signer and legacy
 * alias fields; this layer only adds the intent/execution/settlement truth.
 */
export function buildWorkReceipt({ session, job, verification, context = {} }) {
  const runReceipt = buildRunReceipt({ session, job, verification, context });
  const profile = runReceipt.verifier.handler;
  const version = runReceipt.verifier.version;
  const poster = resolvePoster(job, context);
  if (!poster) throw new ValidationError("Work receipt requires the funding poster address.");

  const intent = buildIntent({ session, job, profile, version, poster, context });
  const execution = buildExecution({ session, verification, runReceipt, context });
  const settlement = buildSettlement({ session, job, verification, legacy: runReceipt.settlement });
  const checkDepth = verificationDepthForJob(job);
  if (verification?.outcome === "approved" && !settlement) {
    throw new ValidationError("Approved work receipt requires complete settlement evidence.");
  }
  if (settlement && intent.valueAtRisk.amountRaw !== settlement.rewardAmountRaw) {
    throw new ValidationError(
      "Work receipt intent valueAtRisk.amountRaw must equal settlement rewardAmountRaw."
    );
  }
  const unsigned = compact({
    ...runReceipt,
    schemaVersion: WORK_RECEIPT_SCHEMA_VERSION,
    receiptType: "work_outcome",
    attestation: "A single work run: the agreed intent, submitted evidence, verification outcome, and any resulting settlement. It makes no broader claim.",
    verifier: compact({
      ...runReceipt.verifier,
      profile,
      // One-release aliases retained above as handler/version.
      handler: profile,
      version
    }),
    verification: checkDepth ? { checkDepth } : undefined,
    intent,
    execution,
    settlement
  });
  const receiptId = hashWorkReceiptContent(unsigned);
  const siteOrigin = firstString(context.publicReceiptBaseUrl, context.publicSiteUrl) ?? WORK_RECEIPT_SITE_ORIGIN;
  return {
    ...unsigned,
    receiptId,
    canonicalUrl: `${siteOrigin.replace(/\/+$/u, "")}/receipts/${receiptId}`
  };
}

/**
 * Build the same portable, content-addressed receipt for a standalone Verify
 * run. This producer deliberately has no job/session compatibility shim and no
 * settlement section: the customer brought the artifact and paid only for the
 * computation described by the pinned profile.
 */
export function buildVerifyReceipt({ run, profile, execution, verdict, context = {} }) {
  const customer = address(run?.customer);
  if (!customer) throw new ValidationError("Verify receipt requires the paying customer address.");
  if (!profile?.ref || !profile?.name || !Number.isInteger(Number(profile?.version))) {
    throw new ValidationError("Verify receipt requires a pinned profile@version.");
  }
  const outcome = firstString(verdict?.outcome)?.toLowerCase();
  if (!["approved", "rejected", "inconclusive", "platform_fault"].includes(outcome)) {
    throw new ValidationError(`Verify receipt has invalid outcome ${JSON.stringify(outcome)}.`);
  }
  const reasonCode = firstString(verdict?.reasonCode);
  if (!reasonCode) throw new ValidationError("Verify receipt requires a reasonCode.");
  const specHash = hashCanonicalContent({
    profile: profile.ref,
    target: run.target,
    inputs: run.inputs
  });
  const billed = run?.billing?.status === "captured";
  const price = profile.price ?? {};
  const valueAtRisk = billed
    ? { asset: price.asset, amount: String(price.amount), amountRaw: String(price.amountRaw) }
    : { asset: price.asset, amount: "0", amountRaw: "0" };
  const artifactHash = bytes32(execution?.artifactHash)
    ?? hashCanonicalContent(run.inputs?.patch ?? run.inputs ?? null);
  const sourceBinding = normalizeSourceBinding(execution?.sourceBinding);
  const unsigned = compact({
    schemaVersion: WORK_RECEIPT_SCHEMA_VERSION,
    receiptType: "work_outcome",
    attestation: "A single standalone verification run: the requested intent, bounded execution evidence, and resulting verdict. It makes no broader claim.",
    verifier: {
      mode: profile.handler,
      profile: profile.name,
      profileRef: profile.ref,
      version: Number(profile.version),
      handler: profile.handler,
      handlerVersion: Number(profile.handlerVersion)
    },
    verdict: {
      outcome,
      reasonCode,
      reason: firstString(verdict?.reason),
      evidenceHash: bytes32(verdict?.evidenceHash)
        ?? hashCanonicalContent(verdict?.evidence ?? execution?.report ?? null),
      workerConsequence: "none"
    },
    intent: {
      specHash,
      specSource: "verify_request",
      successPolicy: { profile: profile.name, version: Number(profile.version), ref: profile.ref },
      valueAtRisk,
      deadline: { timeoutMs: Number(profile.limits?.timeoutMs) },
      poster: customer,
      posterClass: "external"
    },
    execution: compact({
      provider: customer,
      providerClass: "external",
      target: run.target,
      artifactHash,
      sourceBinding,
      evidenceHash: bytes32(verdict?.evidenceHash)
        ?? hashCanonicalContent(verdict?.evidence ?? execution?.report ?? null),
      environment: execution?.environment,
      checks: normalizeVerifyChecks(execution?.report?.checks)
    }),
    signers: Array.isArray(context.signers) ? context.signers : undefined
  });
  const receiptId = hashWorkReceiptContent(unsigned);
  const siteOrigin = firstString(context.publicReceiptBaseUrl, context.publicSiteUrl) ?? WORK_RECEIPT_SITE_ORIGIN;
  return {
    ...unsigned,
    receiptId,
    canonicalUrl: `${siteOrigin.replace(/\/+$/u, "")}/receipts/${receiptId}`
  };
}

function normalizeVerifyChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return undefined;
  return checks.map((check) => {
    const name = firstString(check?.name);
    const verdict = firstString(check?.verdict)?.toLowerCase();
    const reason = firstString(check?.reason);
    const detail = firstString(check?.detail);
    if (!name || !["pass", "fail", "inconclusive"].includes(verdict) || !reason || !detail) {
      throw new ValidationError("Verify receipt check evidence is malformed.");
    }
    return { name, verdict, reason, detail };
  });
}

/** Hash the portable payload, excluding identities/signatures and self-links. */
export function hashWorkReceiptContent(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ValidationError("Work receipt content must be a JSON object.");
  }
  const {
    receiptId: _receiptId,
    canonicalUrl: _canonicalUrl,
    signers: _signers,
    signature: _signature,
    ...content
  } = document;
  return hashCanonicalContent(content);
}

export function assertWorkReceiptContentAddress(document) {
  const expected = bytes32(document?.receiptId);
  const actual = hashWorkReceiptContent(document);
  if (!expected || expected !== actual) {
    throw new ValidationError(`Work receipt content address mismatch: expected ${expected ?? "missing"}, reproduced ${actual}.`);
  }
  return true;
}

function buildIntent({ session, job, profile, version, poster, context }) {
  const snapshot = session?.jobSnapshot;
  const specHash = bytes32(snapshot?.specHash);
  if (!specHash) throw new ValidationError("Work receipt intent requires the claim-time specHash.");
  const specSource = snapshot?.specSource ?? "chain_unavailable_fail_open";
  if (!["chain_verified", "chain_unavailable_fail_open"].includes(specSource)) {
    throw new ValidationError(`Work receipt has invalid specSource ${JSON.stringify(specSource)}.`);
  }
  const deadline = firstIso(
    session?.chainClaimExpiresAt,
    session?.claimExpiresAt,
    claimExpiresAt(session, job),
    job?.submissionDeadline,
    job?.deadline
  );
  if (!deadline) throw new ValidationError("Work receipt intent requires the claim expiry or submission deadline.");
  const valueAtRisk = rewardAtClaim(session, job);
  const posterIdentity = context.selfIdentityRegistry?.classify?.({ wallet: poster });
  return {
    specHash,
    specSource,
    successPolicy: { profile, version },
    valueAtRisk,
    deadline,
    poster,
    posterClass: posterIdentity?.self === true || !isExternalJob(job) ? "operator" : "external"
  };
}

function rewardAtClaim(session, job) {
  const snapshotJob = session?.jobSnapshot?.definition ?? job ?? {};
  const asset = firstString(snapshotJob.rewardAsset, job?.rewardAsset);
  const amountValue = snapshotJob.rewardAmount ?? job?.rewardAmount;
  const decimals = decimalsForAssetSymbol(asset);
  const amountRaw = unsignedIntegerString(
    session?.jobSnapshot?.claimEconomics?.gasRetention?.rewardRaw
      ?? session?.gasRetention?.rewardRaw
  ) ?? decimalToBaseUnits(amountValue, decimals, "work receipt reward").toString();
  return { asset, amount: String(amountValue), amountRaw };
}

function buildExecution({ session, verification, runReceipt, context }) {
  const identity = context.selfIdentityRegistry?.classify?.({ wallet: session.wallet, session });
  const providerClass = identity?.self === true
    ? "ours"
    : identity?.actor === "external"
      ? "external"
      : "unknown";
  const artifactHash = bytes32(
    verification?.artifactHash
      ?? verification?.details?.artifactHash
      ?? session?.submission?.artifactHash
  ) ?? hashSubmission(session.submission ?? verification?.verificationInput ?? null);
  const rawBinding = verification?.sourceBinding
    ?? verification?.details?.sourceBinding
    ?? session?.submission?.sourceBinding
    ?? session?.submission?.source?.binding;
  const sourceBinding = normalizeSourceBinding(rawBinding);
  const environment = verification?.environment
    ?? verification?.details?.environment
    ?? { kind: "verifier_profile", profile: runReceipt.verifier.handler, version: runReceipt.verifier.version };
  return compact({
    provider: runReceipt.worker,
    providerClass,
    artifactHash,
    sourceBinding,
    evidenceHash: runReceipt.verdict.evidenceHash,
    environment
  });
}

function normalizeSourceBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { method: "submission_hash", verified: false };
  }
  return compact({
    method: firstString(value.method, value.format, value.kind) ?? "unspecified",
    verified: value.verified === true || value.bindingVerified === true,
    ref: firstString(value.ref, value.commit, value.baseCommit),
    bundleHash: bytes32(value.bundleHash ?? value.hash ?? value.digest)
  });
}

function buildSettlement({ session, job, verification, legacy }) {
  if (verification?.outcome !== "approved") return undefined;
  const raw = verification?.settlement;
  if (!raw || !legacy) return undefined;
  const gas = raw.gasRetention ?? {};
  const workerAmountRaw = unsignedIntegerString(legacy.workerAmountRaw);
  const protocolFeeAmountRaw = unsignedIntegerString(legacy.protocolFeeAmountRaw);
  const brokered = raw.brokered ?? session?.gasRetention?.brokered ?? !isExternalJob(job);
  const waived = raw.waived ?? session?.gasRetention?.waived ?? session?.claimEconomicsWaived === true;
  const gasRetentionAmountRaw = unsignedIntegerString(
    raw.gasRetentionAmountRaw ?? raw.retainedRaw ?? gas.retainedRaw
  ) ?? "0";
  if (waived && gasRetentionAmountRaw !== "0") {
    throw new ValidationError("Waived work receipt settlement cannot retain gas.");
  }
  const rewardAmountRaw = unsignedIntegerString(
    raw.rewardAmountRaw ?? gas.rewardRaw
  ) ?? (BigInt(workerAmountRaw) + BigInt(gasRetentionAmountRaw)).toString();
  if (BigInt(rewardAmountRaw) !== BigInt(workerAmountRaw) + BigInt(gasRetentionAmountRaw)) {
    throw new ValidationError(
      "Work receipt rewardAmountRaw must equal workerAmountRaw + gasRetentionAmountRaw."
    );
  }
  const posterTotalAmountRaw = unsignedIntegerString(raw.posterTotalAmountRaw) ?? (
    BigInt(workerAmountRaw) + BigInt(gasRetentionAmountRaw) + BigInt(protocolFeeAmountRaw)
  ).toString();
  if (BigInt(posterTotalAmountRaw) !== BigInt(rewardAmountRaw) + BigInt(protocolFeeAmountRaw)) {
    throw new ValidationError(
      "Work receipt posterTotalAmountRaw must equal rewardAmountRaw + protocolFeeAmountRaw."
    );
  }
  const decimals = decimalsForAssetSymbol(legacy.assetSymbol);
  const gasRetentionBps = nonNegativeInteger(raw.gasRetentionBps ?? session?.gasRetention?.retentionCapBps)
    ?? (BigInt(rewardAmountRaw) === 0n
      ? 0
      : Number((BigInt(gasRetentionAmountRaw) * 10_000n) / BigInt(rewardAmountRaw)));
  return compact({
    ...legacy,
    rewardAmount: formatBaseUnits(BigInt(rewardAmountRaw), decimals),
    rewardAmountRaw,
    posterTotalAmount: formatBaseUnits(BigInt(posterTotalAmountRaw), decimals),
    posterTotalAmountRaw,
    gasRetentionAmount: formatBaseUnits(BigInt(gasRetentionAmountRaw), decimals),
    gasRetentionAmountRaw,
    gasRetentionBps,
    brokered: Boolean(brokered),
    waived: Boolean(waived),
    settlementTx: bytes32(verification?.payoutTx?.txHash ?? verification?.settlementTx)
  });
}

function resolvePoster(job, context) {
  return address(
    context.posterAddress
      ?? job?.source?.poster?.wallet
      ?? job?.poster?.wallet
      ?? job?.funding?.wallet
      ?? job?.poster
  );
}

function firstIso(...values) {
  const value = values.find((entry) => typeof entry === "string" && !Number.isNaN(Date.parse(entry)));
  return value ? new Date(value).toISOString() : undefined;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function unsignedIntegerString(value) {
  const normalized = typeof value === "bigint" ? value.toString() : firstString(value);
  return normalized && /^\d+$/u.test(normalized) ? normalized : undefined;
}

function address(value) {
  return typeof value === "string" && ADDRESS_RE.test(value) ? value.toLowerCase() : undefined;
}

function bytes32(value) {
  return typeof value === "string" && BYTES32_RE.test(value) ? value.toLowerCase() : undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
