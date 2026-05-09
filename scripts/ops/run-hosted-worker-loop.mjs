#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_REWARD_AMOUNT = 0.000001;

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
  const rewardAmount = parsePositiveNumber(env.PRODUCT_PROOF_REWARD_AMOUNT, DEFAULT_REWARD_AMOUNT);

  const authSession = await platform.getAuthSession();
  const wallet = authSession?.wallet;
  if (!wallet) {
    throw new Error("/auth/session did not return a wallet for the worker token.");
  }

  const settlementReadiness = await assertSettlementReadiness(platform);

  log(`Creating hosted product-proof job ${jobId}`);
  const created = await platform.createJob({
    id: jobId,
    category: "coding",
    tier: "starter",
    rewardAsset: env.PRODUCT_PROOF_REWARD_ASSET || "DOT",
    rewardAmount,
    verifierMode: "benchmark",
    verifierTerms: ["complete", "verified", "output"],
    verifierMinimumMatches: 2,
    requiresSponsoredGas: true,
    claimTtlSeconds: 3600,
    retryLimit: 1,
    outputSchemaRef: "schema://jobs/product-proof-worker-loop"
  });
  if (created?.id !== jobId) {
    throw new Error(`created job id mismatch: expected ${jobId}, got ${created?.id ?? "missing"}`);
  }

  log(`Claiming hosted product-proof job ${jobId}`);
  const claim = await platform.claimJob(jobId, idempotencyKey);
  const sessionId = claim?.sessionId;
  if (!sessionId) {
    throw new Error("claim response did not include sessionId.");
  }

  log(`Submitting hosted product-proof session ${sessionId}`);
  const submit = await platform.submitWork(sessionId, evidence);
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
    settlementReadiness,
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

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PRODUCT_PROOF_REWARD_AMOUNT must be greater than zero; got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

async function assertSettlementReadiness(platform) {
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
  return {
    policyAddress: policy.policyAddress,
    paused: Boolean(policy.paused),
    settlementReady: true,
    roles: {
      signerAddress: policy.roles?.signerAddress,
      signerIsVerifier: Boolean(policy.roles?.signerIsVerifier),
      escrowIsServiceOperator: Boolean(policy.roles?.escrowIsServiceOperator)
    },
    contracts: policy.contracts
  };
}

function formatSettlementReadiness(policy) {
  const reasons = [];
  if (policy?.paused) reasons.push("policyPaused=true");
  if (!policy?.roles?.signerIsVerifier) reasons.push("signerIsVerifier=false");
  if (!policy?.roles?.escrowIsServiceOperator) reasons.push("escrowIsServiceOperator=false");
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
