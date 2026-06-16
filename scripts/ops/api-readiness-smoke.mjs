#!/usr/bin/env node
//
// STANDALONE API-ONLY CLAIM-READINESS SMOKE.
//
// A fast, READ-ONLY probe of the external-worker front door. Walks the real
// SIWE login as a fresh roleless wallet and checks a job is claimable + funded
// — WITHOUT claiming, submitting, settling, or touching the chain RPC:
//
//   1. SIWE     — nonce → sign → verify → usable roleless token   (guards #625)
//   2. Account  — authed GET /account with that token, not 401     (guards #626)
//   3. Preflight— GET /jobs/preflight for a claimable job: eligible + claimable
//                 + currentWalletCanClaim, surfacing fundingState/reason
//                 (guards the claim-409 / reward_funding_pending class)
//   4. Funding  — OPTIONAL operator tier: if an admin token is supplied, assert
//                 /admin/status maintenance.policy.enabled + settlementReady and
//                 report escrowIsServiceOperator + signerFunding
//
// WHY THIS EXISTS: run-worker-canary.mjs is the full proof, but stages 6-7
// (on-chain settle + token freshness) need a live RPC + functional settlement,
// so it can't run as a quick liveness probe and is gated behind the Docker/
// Hermes stack via check-hosted-stack.sh. The 2026-06-13 round-trip showed the
// front-door blockers (SIWE mint 500, JWT sub-casing 401, claim 409) each cost
// a full user round-trip to find. This probe catches that whole class against
// the live API in seconds, with no stack and no on-chain mutation — so it's
// safe to run on every deploy and in a tight loop.
//
// It deliberately does NOT claim/submit/settle: zero on-chain writes, no funds
// spent, no disposable job created. The worker stages run as a FRESH ROLELESS
// wallet (ephemeral by default — read-only needs no provisioned key); the
// optional operator tier reuses the hosted-loop admin auth only to read
// /admin/status.
//
// Reuses runSiweStage / runAccountStage from run-worker-canary.mjs so the
// #625/#626 guard semantics stay identical. Mirrors the ops-script shape:
// an exported async fn + a CLI entry, exercised offline by
// api-readiness-smoke.test.mjs.

import { Wallet } from "ethers";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";
import { runSiweStage, runAccountStage } from "./run-worker-canary.mjs";
import { readOpSecret } from "./get-admin-refresh-token.mjs";
import { resolveHostedWorkerLoopAuth } from "./run-hosted-worker-loop.mjs";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
// Same dedicated roleless testnet wallet the canary uses, when provisioned.
const DEFAULT_WORKER_KEY_OP = "op://prod-backend/canary-worker-testnet/private key";

function pick(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : undefined;
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

// A fresh roleless wallet is the right SIWE subject (mirrors a real external
// agent). Read-only means no funds are needed, so ephemeral is the zero-config
// default; a provisioned key is honored when present for parity with the canary.
async function resolveWorkerWallet({ env, readSecretImpl, log }) {
  const explicit = pick(env.API_SMOKE_WORKER_PRIVATE_KEY) ?? pick(env.WORKER_CANARY_WORKER_PRIVATE_KEY);
  if (explicit) {
    return { wallet: new Wallet(explicit), source: "private_key" };
  }
  const opRef = pick(env.API_SMOKE_WORKER_KEY_OP) ?? pick(env.WORKER_CANARY_WORKER_KEY_OP);
  if (opRef) {
    try {
      const key = (await readSecretImpl(opRef)).trim();
      if (key) {
        return { wallet: new Wallet(key), source: `op:${opRef}` };
      }
    } catch (error) {
      log(`Could not read worker key from ${opRef} (${error?.message ?? error}); falling back to ephemeral.`);
    }
  }
  // Default: a throwaway roleless wallet. Read-only — it never spends or claims.
  log("Using an ephemeral roleless worker wallet (read-only probe; no funds required).");
  return { wallet: Wallet.createRandom(), source: "ephemeral" };
}

// Resolve an operator token for the OPTIONAL /admin/status tier. Returns null
// when no admin credential is configured — the probe stays worker-only then.
async function resolveOperatorAuth({ env, readSecretImpl, log }) {
  if (!pick(env.ADMIN_JWT) && !pick(env.ADMIN_REFRESH_TOKEN) && !pick(env.ADMIN_REFRESH_TOKEN_OP)) {
    return null;
  }
  try {
    return await resolveHostedWorkerLoopAuth({ env, readSecretImpl });
  } catch (error) {
    log(`Operator tier skipped: could not resolve admin auth (${error?.message ?? error}).`);
    return null;
  }
}

function firstClaimableJobId(listing) {
  const jobs = Array.isArray(listing)
    ? listing
    : Array.isArray(listing?.jobs)
      ? listing.jobs
      : Array.isArray(listing?.items)
        ? listing.items
        : [];
  for (const job of jobs) {
    const id = job?.id ?? job?.jobId;
    if (typeof id === "string" && id.length) {
      return id;
    }
  }
  return undefined;
}

// ── STAGE 3: preflight (read-only) ──────────────────────────────────────────
// Resolves a claimable job (explicit id, else discovers one) and asserts a
// fresh worker CAN claim it — surfacing fundingState/reason so a stuck
// reward_funding_pending job is reported, not silently passed.
export async function runPreflightStage({ authedWorker, explicitJobId, log }) {
  let jobId = explicitJobId;
  if (!jobId) {
    const listing = await authedWorker.listClaimableJobs();
    jobId = firstClaimableJobId(listing);
  }
  if (!jobId) {
    // No claimable job advertised. That is itself a readiness signal (an empty
    // or fully funding-pending board), not a transport failure — report it.
    return {
      ok: false,
      reason: "no_claimable_job",
      detail: "Discovery returned no claimable job to preflight (empty board or all rewards funding-pending)."
    };
  }

  const preflight = await authedWorker.preflightJob(jobId);
  if (!preflight || preflight.jobId !== jobId) {
    throw new Error(
      `Preflight stage: /jobs/preflight job id mismatch: expected ${jobId}, got ${preflight?.jobId ?? "missing"}.`
    );
  }
  const claimable =
    preflight.eligible === true &&
    preflight.claimable === true &&
    preflight.currentWalletCanClaim !== false;
  if (!claimable) {
    return {
      ok: false,
      jobId,
      reason: preflight.reason ?? "not_claimable",
      detail:
        `preflight says the worker cannot claim — eligible=${String(preflight.eligible)}; ` +
        `claimable=${String(preflight.claimable)}; currentWalletCanClaim=${String(preflight.currentWalletCanClaim)}; ` +
        `fundingState=${preflight.fundingState ?? "n/a"}; reason=${preflight.reason ?? "none"}.`
    };
  }
  log?.(`preflight OK — ${jobId} is claimable by a fresh worker.`);
  return {
    ok: true,
    jobId,
    fundingState: preflight.fundingState ?? null,
    claimEconomicsWaived: preflight.claimEconomicsWaived ?? null,
    totalClaimLock: preflight.totalClaimLock ?? null
  };
}

// ── STAGE 4: funding/settlement readiness (optional operator tier) ──────────
export async function runFundingStage({ operatorClient }) {
  const status = await operatorClient.getAdminStatus();
  const policy = status?.maintenance?.policy;
  if (!policy?.enabled || policy.settlementReady !== true) {
    return {
      ok: false,
      reason: "settlement_not_ready",
      detail:
        `/admin/status maintenance.policy not settlement-ready — enabled=${String(policy?.enabled)}; ` +
        `settlementReady=${String(policy?.settlementReady)}. Brokered claim/submit/settle cannot complete.`,
      signerFunding: policy?.signerFunding ?? null
    };
  }
  return {
    ok: true,
    settlementReady: true,
    escrowIsServiceOperator: policy.roles?.escrowIsServiceOperator ?? null,
    signerFunding: policy.signerFunding ?? null
  };
}

export async function runApiReadinessSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readSecretImpl = readOpSecret,
  workerWallet = undefined, // injected (tests)
  anonClient = undefined, // injected (tests): pre-SIWE worker client
  authedWorker = undefined, // injected (tests): post-SIWE worker client
  operatorClient = undefined, // injected (tests)
  operatorAuth = undefined, // injected (tests): truthy to force the operator tier
  log = (message) => console.error(message)
} = {}) {
  const apiBaseUrl = pick(env.API_SMOKE_API_BASE_URL) ?? pick(env.API_BASE_URL) ?? DEFAULT_API_BASE_URL;
  const startedAt = Date.now();
  const stages = {};

  const { wallet, source: workerSource } =
    workerWallet ? { wallet: workerWallet, source: "injected" } : await resolveWorkerWallet({ env, readSecretImpl, log });

  // Stage 1 — SIWE (reused: identical #625 guard).
  const siwe = await runSiweStage({
    apiBaseUrl,
    wallet,
    fetchImpl,
    ...(anonClient ? { anonClient } : {})
  });
  stages.siwe = { ok: true, roleless: true, workerSource, ...siwe.summary };

  const worker =
    authedWorker ?? new AgentPlatformClient({ baseUrl: apiBaseUrl, token: siwe.token, fetchImpl });

  // Stage 2 — authed read (reused: identical #626 guard).
  const account = await runAccountStage({ authedWorker: worker, workerAddress: wallet.address });
  stages.account = { ok: true, wallet: account.wallet };

  // Stage 3 — preflight (read-only).
  const preflight = await runPreflightStage({
    authedWorker: worker,
    explicitJobId: pick(env.API_SMOKE_JOB_ID),
    log
  });
  stages.preflight = preflight;

  // Stage 4 — optional operator-tier funding/settlement readiness.
  const opAuth = operatorAuth ?? (await resolveOperatorAuth({ env, readSecretImpl, log }));
  if (opAuth || operatorClient) {
    const opClient =
      operatorClient ??
      new AgentPlatformClient({ baseUrl: apiBaseUrl, token: opAuth.token, fetchImpl });
    stages.funding = await runFundingStage({ operatorClient: opClient });
  } else {
    stages.funding = { ok: true, skipped: true, detail: "no admin credential — worker-tier probe only" };
  }

  const ok = Object.values(stages).every((stage) => stage.ok !== false);
  return {
    ok,
    apiBaseUrl,
    worker: wallet.address,
    elapsedMs: Date.now() - startedAt,
    stages
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runApiReadinessSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    });
}
