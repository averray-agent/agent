#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";
import { DEFAULT_ESCROW_ASSET } from "../../mcp-server/src/core/assets.js";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const PRODUCT_PROOF_OUTPUT_SCHEMA_REF = "schema://jobs/product-proof-worker-loop";
// Above USDC's current Asset Hub minBalance of 70_000 base units. The
// explicit minBalance preflight below remains the launch gate; this is
// just a humane default for manual workflow dispatches.
const DEFAULT_REWARD_AMOUNT = 0.1;
const REQUIRED_ESCROW_ASSET = {
  symbol: DEFAULT_ESCROW_ASSET.symbol,
  address: DEFAULT_ESCROW_ASSET.address.toLowerCase(),
  assetClass: DEFAULT_ESCROW_ASSET.assetClass,
  assetId: DEFAULT_ESCROW_ASSET.assetId,
  decimals: DEFAULT_ESCROW_ASSET.decimals,
  minBalanceRaw: DEFAULT_ESCROW_ASSET.minBalanceRaw
};

export async function runHostedWorkerLoop({
  env = process.env,
  client = undefined,
  now = () => Date.now(),
  log = console.log
} = {}) {
  const apiBaseUrl = stripTrailingSlash(env.API_BASE_URL || DEFAULT_API_BASE_URL);
  const token = env.PRODUCT_PROOF_WORKER_TOKEN || env.AVERRAY_TOKEN || env.ADMIN_JWT;
  if (!token) {
    throw new Error("PRODUCT_PROOF_WORKER_TOKEN, AVERRAY_TOKEN, or ADMIN_JWT is required.");
  }

  const platform = client ?? new AgentPlatformClient({ baseUrl: apiBaseUrl, token });
  const timestamp = now();
  const jobId = env.PRODUCT_PROOF_JOB_ID || `product-proof-worker-loop-${timestamp}`;
  const idempotencyKey = env.PRODUCT_PROOF_IDEMPOTENCY_KEY || `product-proof:${jobId}`;
  const evidence = env.PRODUCT_PROOF_SUBMISSION || `complete verified output for ${jobId}`;
  const submission = buildProductProofSubmission({ jobId, evidence, timestamp });
  const rewardAmountInput = parsePositiveDecimalString(env.PRODUCT_PROOF_REWARD_AMOUNT, DEFAULT_REWARD_AMOUNT);
  const rewardAmount = Number(rewardAmountInput);
  const rewardAsset = normalizeAssetSymbol(env.PRODUCT_PROOF_REWARD_ASSET || REQUIRED_ESCROW_ASSET.symbol);
  if (rewardAsset !== REQUIRED_ESCROW_ASSET.symbol) {
    throw new Error(
      `Hosted product-proof worker loop requires ${REQUIRED_ESCROW_ASSET.symbol} settlement; got PRODUCT_PROOF_REWARD_ASSET=${rewardAsset}.`
    );
  }

  const authSession = await platform.getAuthSession();
  const wallet = authSession?.wallet;
  if (!wallet) {
    throw new Error("/auth/session did not return a wallet for the worker token.");
  }
  const authReadiness = assertWorkerTokenReadiness(authSession);

  const settlementReadiness = await assertSettlementReadiness(platform, rewardAsset);
  const rewardReadiness = assertRewardClearsAssetMinBalance({
    rewardAsset,
    rewardAmount: rewardAmountInput,
    asset: settlementReadiness.asset
  });
  const liquidityReadiness = await assertProductProofLiquidity({
    platform,
    wallet,
    rewardAsset,
    rewardAmount: rewardAmountInput,
    settlementReadiness
  });

  log(`Creating hosted product-proof job ${jobId}`);
  const created = await platform.createJob({
    id: jobId,
    category: "coding",
    tier: "starter",
    rewardAsset,
    rewardAmount,
    verifierMode: "benchmark",
    verifierTerms: ["complete", "verified", "output"],
    verifierMinimumMatches: 2,
    requiresSponsoredGas: true,
    claimTtlSeconds: 3600,
    retryLimit: 1,
    outputSchemaRef: PRODUCT_PROOF_OUTPUT_SCHEMA_REF
  });
  if (created?.id !== jobId) {
    throw new Error(`created job id mismatch: expected ${jobId}, got ${created?.id ?? "missing"}`);
  }

  log(`Preflighting hosted product-proof job ${jobId}`);
  const preflight = await platform.preflightJob(jobId);
  const preflightReadiness = assertClaimPreflightReady({ preflight, jobId, wallet });

  log(`Validating hosted product-proof submission for ${jobId}`);
  const validationReadiness = await assertSubmissionValidationReady({
    platform,
    jobId,
    preflightReadiness,
    submission
  });
  const invalidValidationReadiness = await assertInvalidSubmissionBlocked({
    platform,
    jobId,
    preflightReadiness
  });

  log(`Claiming hosted product-proof job ${jobId}`);
  const claim = await platform.claimJob(jobId, idempotencyKey);
  const sessionId = claim?.sessionId;
  if (!sessionId) {
    throw new Error("claim response did not include sessionId.");
  }

  log(`Submitting hosted product-proof session ${sessionId}`);
  const submit = await platform.submitWork(sessionId, submission);
  if (submit?.status !== "submitted") {
    throw new Error(`expected submitted status, got ${submit?.status ?? "missing"}`);
  }

  log(`Verifying hosted product-proof session ${sessionId}`);
  const verification = await platform.runVerifier(sessionId, evidence);
  if (verification?.outcome !== "approved") {
    throw new Error(`expected approved verifier outcome, got ${verification?.outcome ?? "missing"}`);
  }

  const session = await platform.getSession(sessionId);
  if (session?.status !== "resolved") {
    throw new Error(`expected resolved session, got ${session?.status ?? "missing"}`);
  }

  const badgeUrl = `${apiBaseUrl}/badges/${encodeURIComponent(sessionId)}`;
  const profileUrl = `${apiBaseUrl}/agents/${encodeURIComponent(wallet)}`;
  const [badge, profile] = await Promise.all([
    platform.getAgentBadge(sessionId),
    platform.getAgentProfile(wallet)
  ]);

  if (badge?.averray?.sessionId !== sessionId || badge?.averray?.jobId !== jobId) {
    throw new Error("badge did not reference the product-proof session and job.");
  }
  if (!Array.isArray(profile?.badges) || !profile.badges.some((entry) => entry.sessionId === sessionId && entry.jobId === jobId)) {
    throw new Error("agent profile did not include the product-proof badge.");
  }

  const evidenceDoc = {
    apiBaseUrl,
    wallet,
    jobId,
    sessionId,
    badgeUrl,
    profileUrl,
    verificationOutcome: verification.outcome,
    verificationReasonCode: verification.reasonCode ?? null,
    authReadiness,
    settlementReadiness,
    rewardReadiness,
    liquidityReadiness,
    preflightReadiness,
    validationReadiness,
    invalidValidationReadiness,
    claimReadiness: {
      status: claim.status ?? null,
      sessionId,
      claimExpiresAt: claim.claimExpiresAt ?? claim.deadline ?? null
    },
    submitStatus: submit.status,
    sessionStatus: session.status,
    completedAt: new Date(timestamp).toISOString()
  };

  if (env.PRODUCT_PROOF_EVIDENCE_FILE) {
    await mkdir(dirname(env.PRODUCT_PROOF_EVIDENCE_FILE), { recursive: true });
    await writeFile(env.PRODUCT_PROOF_EVIDENCE_FILE, `${JSON.stringify(evidenceDoc, null, 2)}\n`);
    log(`Wrote product-proof evidence to ${env.PRODUCT_PROOF_EVIDENCE_FILE}`);
  }

  return evidenceDoc;
}

function buildProductProofSubmission({ jobId, evidence, timestamp }) {
  const completedAt = new Date(timestamp).toISOString();
  return {
    summary: evidence,
    output: evidence,
    status: "complete",
    job_id: jobId,
    completed_at: completedAt,
    checks: [
      {
        name: "worker_output",
        status: "pass",
        evidence
      },
      {
        name: "schema_contract",
        status: "pass",
        evidence: `Submission targets ${PRODUCT_PROOF_OUTPUT_SCHEMA_REF}.`
      }
    ]
  };
}

async function assertInvalidSubmissionBlocked({ platform, jobId, preflightReadiness }) {
  if (typeof platform.validateJobSubmission !== "function") {
    throw new Error("Hosted product-proof worker loop requires /jobs/validate-submission before claim.");
  }
  const invalidSubmission = {
    output: {
      wrapped_under_submission_output: true
    }
  };
  const validation = await platform.validateJobSubmission(jobId, invalidSubmission);
  if (!validation || typeof validation !== "object") {
    throw new Error("Hosted product-proof worker loop requires an invalid validation response before claim.");
  }
  if (validation.jobId && validation.jobId !== jobId) {
    throw new Error(`invalid submission validation job id mismatch: expected ${jobId}, got ${validation.jobId}`);
  }
  if (validation.valid !== false || validation.submitSafe !== false) {
    throw new Error(
      "invalid product-proof submission unexpectedly passed validation before claim; " +
      `valid=${String(validation.valid)}; submitSafe=${String(validation.submitSafe)}.`
    );
  }
  const expectedSchemaRef = preflightReadiness.requiredOutputSchema ?? PRODUCT_PROOF_OUTPUT_SCHEMA_REF;
  if (validation.schemaRef && validation.schemaRef !== expectedSchemaRef) {
    throw new Error(
      `invalid submission validation schema mismatch: expected ${expectedSchemaRef}, got ${validation.schemaRef}`
    );
  }
  return {
    jobId,
    valid: false,
    submitSafe: false,
    schemaRef: validation.schemaRef ?? expectedSchemaRef,
    schemaValidates: validation.schemaValidates ?? "payload.submission",
    code: validation.code ?? null,
    message: validation.message ?? null,
    path: validation.path ?? validation.errorPaths?.[0] ?? null,
    received: validation.details?.received ?? null,
    hint: validation.details?.hint ?? null,
    checkedBeforeClaim: true,
    submitAttempted: false
  };
}

async function assertSubmissionValidationReady({ platform, jobId, preflightReadiness, submission }) {
  if (typeof platform.validateJobSubmission !== "function") {
    throw new Error("Hosted product-proof worker loop requires /jobs/validate-submission before claim.");
  }
  const validation = await platform.validateJobSubmission(jobId, submission);
  if (!validation || typeof validation !== "object") {
    throw new Error("Hosted product-proof worker loop requires a validation response before claim.");
  }
  if (validation.jobId && validation.jobId !== jobId) {
    throw new Error(`submission validation job id mismatch: expected ${jobId}, got ${validation.jobId}`);
  }
  if (validation.valid !== true) {
    const code = validation.code ?? "invalid_submission";
    const message = validation.message ?? "submission failed schema validation";
    throw new Error(`submission validation failed before claim: code=${code}; message=${message}`);
  }
  const expectedSchemaRef = preflightReadiness.requiredOutputSchema ?? PRODUCT_PROOF_OUTPUT_SCHEMA_REF;
  if (validation.schemaRef && validation.schemaRef !== expectedSchemaRef) {
    throw new Error(
      `submission validation schema mismatch: expected ${expectedSchemaRef}, got ${validation.schemaRef}`
    );
  }
  return {
    jobId,
    valid: true,
    schemaRef: validation.schemaRef ?? expectedSchemaRef,
    schemaValidates: validation.schemaValidates ?? "payload.submission",
    submissionKind: validation.submissionKind ?? "structured",
    validatedBeforeClaim: true
  };
}

async function assertProductProofLiquidity({ platform, wallet, rewardAsset, rewardAmount, settlementReadiness }) {
  if (typeof platform.getAccountSummary !== "function") {
    throw new Error("Hosted product-proof worker loop requires /account liquidity readiness.");
  }

  const account = await platform.getAccountSummary();
  if (!sameWallet(account?.wallet, wallet)) {
    throw new Error(
      `Hosted product-proof worker loop requires /account to match /auth/session; ` +
      `authWallet=${wallet}; accountWallet=${account?.wallet ?? "missing"}.`
    );
  }
  const asset = settlementReadiness.asset;
  const decimals = Number(asset.decimals);
  const requiredRaw = toBaseUnits(rewardAmount, decimals);
  const availableRaw = toBigIntAmount(account?.liquid?.[rewardAsset], `${rewardAsset} liquid balance`);
  if (availableRaw < requiredRaw) {
    const agentAccountAddress = settlementReadiness.contracts?.agentAccountAddress ?? "AgentAccountCore";
    throw new Error(
      `Hosted product-proof worker loop requires funded ${rewardAsset} liquidity before mutation; ` +
      `wallet=${wallet}; account=${agentAccountAddress}; required=${formatBaseUnits(requiredRaw, decimals)} ${rewardAsset} ` +
      `(raw ${requiredRaw}); available=${formatBaseUnits(availableRaw, decimals)} ${rewardAsset} (raw ${availableRaw}). ` +
      `Fund by approving ${agentAccountAddress} on the canonical ${rewardAsset} ERC20 precompile and depositing into AgentAccountCore.`
    );
  }
  return {
    wallet,
    asset: rewardAsset,
    requiredRaw: requiredRaw.toString(),
    availableRaw: availableRaw.toString(),
    required: formatBaseUnits(requiredRaw, decimals),
    available: formatBaseUnits(availableRaw, decimals)
  };
}

function assertRewardClearsAssetMinBalance({ rewardAsset, rewardAmount, asset }) {
  const decimals = Number(asset?.decimals);
  const rewardRaw = toBaseUnits(rewardAmount, decimals);
  const minBalanceRaw = minBalanceRawForAsset(asset);
  if (minBalanceRaw === undefined) {
    throw new Error(
      `Hosted product-proof worker loop requires ${rewardAsset} minBalance metadata before mutation. ` +
      `Expose minBalanceRaw for the settlement asset in /admin/status.`
    );
  }
  if (rewardRaw < minBalanceRaw) {
    throw new Error(
      `Hosted product-proof worker loop reward below asset minBalance: asset=${rewardAsset} ` +
      `(id=${asset.assetId ?? "unknown"}) minBalance=${minBalanceRaw} base units ` +
      `(${formatBaseUnits(minBalanceRaw, decimals)} ${rewardAsset}); reward=${rewardAmount} ${rewardAsset} ` +
      `= ${rewardRaw} base units. Increase PRODUCT_PROOF_REWARD_AMOUNT, or pre-fund the worker's asset account so it stays alive.`
    );
  }
  return {
    asset: rewardAsset,
    rewardRaw: rewardRaw.toString(),
    reward: formatBaseUnits(rewardRaw, decimals),
    minBalanceRaw: minBalanceRaw.toString(),
    minBalance: formatBaseUnits(minBalanceRaw, decimals)
  };
}

function assertWorkerTokenReadiness(authSession) {
  const requiredCapabilities = [
    "account:read",
    "admin:status",
    "jobs:create",
    "jobs:preflight",
    "jobs:claim",
    "jobs:submit",
    "verifier:run",
    "session:read"
  ];
  const capabilities = Array.isArray(authSession?.capabilities) ? authSession.capabilities : [];
  const roles = Array.isArray(authSession?.roles) ? authSession.roles : [];
  const missing = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    throw new Error(
      "Hosted product-proof worker loop requires a token with all mutation-loop capabilities before mutation; " +
      `missing=${missing.join(",")}; roles=${roles.join(",") || "none"}.`
    );
  }
  return {
    roles: [...roles],
    requiredCapabilities,
    capabilitiesPresent: requiredCapabilities
  };
}

function assertClaimPreflightReady({ preflight, jobId, wallet }) {
  if (!preflight || typeof preflight !== "object") {
    throw new Error("Hosted product-proof worker loop requires /jobs/preflight before claim.");
  }
  if (preflight.jobId !== jobId) {
    throw new Error(`preflight job id mismatch: expected ${jobId}, got ${preflight.jobId ?? "missing"}`);
  }
  if (preflight.wallet && !sameWallet(preflight.wallet, wallet)) {
    throw new Error(
      `Hosted product-proof worker loop preflight wallet mismatch: authWallet=${wallet}; preflightWallet=${preflight.wallet}.`
    );
  }
  if (preflight.eligible !== true || preflight.claimable !== true || preflight.currentWalletCanClaim === false) {
    throw new Error(
      `Hosted product-proof worker loop preflight failed: ` +
      `eligible=${String(preflight.eligible)}; claimable=${String(preflight.claimable)}; ` +
      `currentWalletCanClaim=${String(preflight.currentWalletCanClaim)}; reason=${preflight.reason ?? "missing"}.`
    );
  }
  return {
    jobId,
    wallet: preflight.wallet ?? wallet,
    eligible: true,
    claimable: true,
    currentWalletCanClaim: preflight.currentWalletCanClaim,
    reason: preflight.reason ?? null,
    requiredOutputSchema: preflight.requiredOutputSchema ?? null,
    verifierMode: preflight.verifierMode ?? null,
    totalClaimLock: preflight.totalClaimLock ?? null,
    claimEconomicsWaived: preflight.claimEconomicsWaived ?? null
  };
}

function normalizeAssetSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function parsePositiveDecimalString(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return normalizeDecimalString(fallback);
  }
  const normalized = normalizeDecimalString(value);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must be greater than zero; got ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function toBaseUnits(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`Settlement asset decimals must be an integer in [0, 30]; got ${JSON.stringify(decimals)}.`);
  }
  const normalized = normalizeDecimalString(amount);
  const [whole, fractional = ""] = normalized.split(".");
  if (fractional.length > decimals) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must fit ${decimals} decimal places; got ${normalized}.`);
  }
  return BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt(fractional.padEnd(decimals, "0") || "0");
}

function normalizeDecimalString(value) {
  if (typeof value === "bigint") return value.toString();
  const raw = typeof value === "number"
    ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 30 })
    : String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must be a positive decimal amount; got ${JSON.stringify(value)}.`);
  }
  return raw;
}

function sameWallet(a, b) {
  return typeof a === "string"
    && typeof b === "string"
    && a.toLowerCase() === b.toLowerCase();
}

function toBigIntAmount(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative safe integer raw amount; got ${value}.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${label} must be present as a raw integer amount.`);
}

function minBalanceRawForAsset(asset) {
  if (!asset) {
    return undefined;
  }
  const raw = asset?.minBalanceRaw ?? (
    describeRequiredAssetMismatch(asset) ? undefined : REQUIRED_ESCROW_ASSET.minBalanceRaw
  );
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "bigint") {
    return raw >= 0n ? raw : undefined;
  }
  const value = String(raw).trim();
  return /^\d+$/u.test(value) ? BigInt(value) : undefined;
}

function formatBaseUnits(raw, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fractional = raw % scale;
  if (fractional === 0n || decimals === 0) return whole.toString();
  const padded = fractional.toString().padStart(decimals, "0").replace(/0+$/u, "");
  return `${whole}.${padded}`;
}

async function assertSettlementReadiness(platform, rewardAsset) {
  if (typeof platform.getAdminStatus !== "function") {
    throw new Error("Hosted product-proof worker loop requires /admin/status settlement readiness.");
  }
  const status = await platform.getAdminStatus();
  const policy = status?.maintenance?.policy;
  if (!policy?.enabled) {
    throw new Error("Hosted product-proof worker loop requires blockchain policy status to be enabled.");
  }
  if (policy.settlementReady !== true) {
    throw new Error(`Hosted product-proof worker loop requires on-chain settlement readiness; ${formatSettlementReadiness(policy)}`);
  }
  const settlementAsset = (policy.contracts?.supportedAssets ?? []).find(
    (asset) => normalizeAssetSymbol(asset.symbol) === rewardAsset
  );
  if (!settlementAsset) {
    throw new Error(
      `Hosted product-proof worker loop requires ${rewardAsset} as the configured settlement asset; ${formatSettlementReadiness(policy)}`
    );
  }
  // Polkadot Hub's ERC20 precompile does not implement name/symbol/decimals.
  // Keep v1 USDC validation on the static record plus policy.approvedAssets.
  const assetMismatch = describeRequiredAssetMismatch(settlementAsset);
  if (assetMismatch) {
    throw new Error(
      `Hosted product-proof worker loop requires canonical v1 ${REQUIRED_ESCROW_ASSET.symbol} settlement asset; ${assetMismatch}; ${formatSettlementReadiness(policy)}`
    );
  }
  if (settlementAsset.approved !== true) {
    throw new Error(
      `Hosted product-proof worker loop requires approved ${rewardAsset} settlement asset; ${formatSettlementReadiness(policy)}`
    );
  }
  return {
    policyAddress: policy.policyAddress,
    paused: Boolean(policy.paused),
    settlementReady: true,
    asset: settlementAsset,
    roles: {
      signerAddress: policy.roles?.signerAddress,
      signerIsVerifier: Boolean(policy.roles?.signerIsVerifier),
      escrowIsServiceOperator: Boolean(policy.roles?.escrowIsServiceOperator),
      agentAccountIsServiceOperator: Boolean(policy.roles?.agentAccountIsServiceOperator)
    },
    contracts: policy.contracts
  };
}

function describeRequiredAssetMismatch(asset) {
  const mismatches = [];
  if (normalizeAssetSymbol(asset.symbol) !== REQUIRED_ESCROW_ASSET.symbol) {
    mismatches.push(`symbol=${asset.symbol ?? "missing"}`);
  }
  if (String(asset.address ?? "").toLowerCase() !== REQUIRED_ESCROW_ASSET.address) {
    mismatches.push(`address=${asset.address ?? "missing"}`);
  }
  if (String(asset.assetClass ?? "") !== REQUIRED_ESCROW_ASSET.assetClass) {
    mismatches.push(`assetClass=${asset.assetClass ?? "missing"}`);
  }
  if (Number(asset.assetId) !== REQUIRED_ESCROW_ASSET.assetId) {
    mismatches.push(`assetId=${asset.assetId ?? "missing"}`);
  }
  if (Number(asset.decimals) !== REQUIRED_ESCROW_ASSET.decimals) {
    mismatches.push(`decimals=${asset.decimals ?? "missing"}`);
  }
  return mismatches.join(", ");
}

function formatSettlementReadiness(policy) {
  const reasons = [];
  if (policy?.paused) reasons.push("policyPaused=true");
  if (!policy?.roles?.signerIsVerifier) reasons.push("signerIsVerifier=false");
  if (!policy?.roles?.escrowIsServiceOperator) reasons.push("escrowIsServiceOperator=false");
  if (!policy?.roles?.agentAccountIsServiceOperator) reasons.push("agentAccountIsServiceOperator=false");
  const unapprovedAssets = (policy?.contracts?.supportedAssets ?? [])
    .filter((asset) => asset.approved !== true)
    .map((asset) => asset.symbol ?? asset.address ?? "unknown");
  if (unapprovedAssets.length > 0) reasons.push(`unapprovedAssets=${unapprovedAssets.join("|")}`);
  if (Array.isArray(policy?.readErrors) && policy.readErrors.length > 0) {
    reasons.push(`policyReadErrors=${policy.readErrors.map((entry) => entry.field).join("|")}`);
  }
  if (policy?.error?.message) reasons.push(`policyError=${policy.error.message}`);
  return reasons.length ? reasons.join(", ") : "settlementReady=false";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHostedWorkerLoop()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
