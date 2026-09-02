#!/usr/bin/env node
//
// End-to-end EXTERNAL-WORKER CANARY.
//
// Walks the REAL SIWE front door with a FRESH, ROLELESS worker wallet and
// drives the full paid loop on a disposable, operator-funded benchmark job:
//
//   1. SIWE   — nonce → sign → verify → usable roleless token   (guards #625)
//   2. Account— authed GET /account with that token, not 401     (guards #626)
//   3. Claim  — claim the disposable job, not 409; waiver|funded  (guards claim 409 + claimJobFor)
//   4. Submit — submit structured output, status submitted, no revert (guards #627 submitWorkFor)
//   5. Verify — operator-triggered benchmark verify → approved    (until auto-verify lands)
//   6. Settle — on-chain job Closed + released == reward, and the
//               worker's balance rose by the reward — checked in BOTH
//               usdc.balanceOf(workerEOA) AND AAC.positions(worker).liquid
//   7. Freshness — the long-lived OPERATOR token isn't within N days
//               of expiry                                          (guards #628 ADMIN_JWT expiry)
//
// WHY THIS EXISTS: the 2026-06-13 first-settled-job round-trip surfaced five
// launch-blockers one at a time (auth mint 500, JWT sub-casing 401, claim 409,
// submitWork revert, ADMIN_JWT expiry). Every prior hosted proof used the
// pre-minted multi-role ADMIN_JWT and bypassed the SIWE front door, so none of
// them could see those bugs. This canary uses a roleless wallet for the worker
// stages (auth/claim/submit) — only the operator stages (create/fund/verify/
// cleanup) use the ADMIN_JWT — so the whole class fails LOUD here, in CI, before
// it reaches an external agent.
//
// SAFETY:
//   - Refuses to run anywhere but Polkadot Hub TestNet (chainId 420420417).
//     The worker stages never touch the admin JWT; the worker key is a
//     dedicated roleless testnet wallet (op://prod-backend/canary-worker-testnet).
//   - Posts its own disposable, UPFRONT-funded job each run and archives it in a
//     finally block, so canary jobs never accumulate or pollute the public board
//     and the loop never depends on the lazy ensureJob path.
//
// Mirrors run-hosted-worker-loop.mjs / run-dispute-verdict-proof.mjs: an
// exported async function + a CLI entry, gated in check-hosted-stack.sh behind
// CHECK_WORKER_CANARY_PROOF=1, exercised offline by run-worker-canary.test.mjs.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Contract, JsonRpcProvider, Wallet } from "ethers";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";
import { DEFAULT_ESCROW_ASSET } from "../../mcp-server/src/core/assets.js";
import { AGENT_ACCOUNT_ABI, ESCROW_CORE_ABI } from "../../mcp-server/src/blockchain/abis.js";
import { resolveHostedWorkerLoopAuth } from "./run-hosted-worker-loop.mjs";
import { readOpSecret } from "./get-admin-refresh-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_PROFILE = "testnet";
// The ONLY chain this canary is allowed to drive. Polkadot Hub (Asset Hub
// Paseo) TestNet. A mainnet manifest or RPC must fail-closed here.
const EXPECTED_TESTNET_CHAIN_ID = 420420417n;
const DEFAULT_REWARD_AMOUNT = "0.1"; // 100_000 base units > USDC minBalance 70_000
const DEFAULT_TOKEN_MIN_DAYS = 7;
const DEFAULT_SETTLE_TIMEOUT_MS = 180_000;
const DEFAULT_SETTLE_POLL_MS = 5_000;
const DEFAULT_WORKER_KEY_OP = "op://prod-backend/canary-worker-testnet/private key";
const OUTPUT_SCHEMA_REF = "schema://jobs/product-proof-worker-loop";
const VERIFIER_TERMS = ["complete", "verified", "output"];
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

// Operator capabilities the canary depends on. If the ADMIN_JWT loses any of
// these (mis-minted, wrong roles), fail loud BEFORE creating a stranded job.
const REQUIRED_OPERATOR_CAPABILITIES = ["jobs:create", "jobs:lifecycle", "verifier:run", "admin:status"];

export async function runWorkerCanary({
  env = process.env,
  workerClient = undefined, // injected (tests): authed worker client (skips real SIWE mint)
  operatorClient = undefined, // injected (tests)
  operatorAuth: injectedOperatorAuth = undefined, // injected (tests): { mode, token }
  chainReader = undefined, // injected (tests): { getChainId, snapshotWorker, readEscrowJob }
  fetchImpl = globalThis.fetch,
  wallet: injectedWallet = undefined,
  resolveOperatorAuth = resolveHostedWorkerLoopAuth,
  readSecretImpl = readOpSecret,
  now = () => Date.now(),
  log = console.log
} = {}) {
  const config = parseConfig(env);
  const startedAt = now();
  const timings = {};
  const stages = {};
  const txHashes = {};
  let createdJobId = null;
  let archived = false;
  let operatorPlatform = operatorClient ?? null;

  const stage = async (name, fn) => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      timings[name] = now() - t0;
    }
  };

  try {
    // ── operator auth (NEVER the worker identity) ─────────────────────────
    const operatorAuth =
      injectedOperatorAuth ??
      (operatorClient
        ? { mode: "injected_client", source: "client", token: config.injectedOperatorToken }
        : await resolveOperatorAuth({
            env: { ...env, API_BASE_URL: config.apiBaseUrl },
            apiBaseUrl: config.apiBaseUrl,
            fetchImpl,
            readSecretImpl
          }));
    log(`Worker canary against ${config.apiBaseUrl} (operator auth: ${operatorAuth.mode})`);
    operatorPlatform =
      operatorClient ?? new AgentPlatformClient({ baseUrl: config.apiBaseUrl, token: operatorAuth.token, fetchImpl });

    // ── chain-env gate: refuse anything that is not testnet ───────────────
    const reader = chainReader ?? buildChainReader(config);
    const chainId = await reader.getChainId();
    assertTestnet({ chainId, profile: config.profile });

    // ── operator readiness: capabilities + settlement, BEFORE creating a job
    await stage("operatorReadiness", () => assertOperatorReady(operatorPlatform, {
      rewardRaw: config.rewardRaw,
      rewardAssetSymbol: DEFAULT_ESCROW_ASSET.symbol
    }));

    // ── worker identity: a fresh, roleless wallet — NOT the admin JWT ─────
    const wallet = injectedWallet ?? (await resolveWorkerWallet({ env, config, readSecretImpl, log }));
    const workerAddress = wallet.address;
    log(`Worker wallet: ${workerAddress} (roleless${config.workerEphemeral ? ", ephemeral" : ""})`);

    // ── create the disposable, UPFRONT-funded benchmark job ───────────────
    const jobId = config.jobId || `worker-canary-${startedAt}`;
    createdJobId = jobId;
    await stage("createJob", async () => {
      log(`Creating disposable canary job ${jobId} (reward ${config.rewardAmount} USDC, funded upfront)`);
      const created = await operatorPlatform.createJob(buildCanaryJob({ jobId, rewardAmount: config.rewardAmount }));
      if (created?.id !== jobId) {
        throw new Error(`created canary job id mismatch: expected ${jobId}, got ${created?.id ?? "missing"}`);
      }
    });

    // ── snapshot worker on-chain balances BEFORE the payout ───────────────
    const before = await reader.snapshotWorker(workerAddress);

    // ── STAGE 1: SIWE front door (guards #625 roleless-mint 500) ──────────
    let authedWorker;
    if (workerClient) {
      // Tests inject an already-authed worker client and skip the live mint.
      stages.siwe = { mode: "injected", roleless: true };
      authedWorker = workerClient;
    } else {
      const siwe = await stage("siwe", () => runSiweStage({ apiBaseUrl: config.apiBaseUrl, wallet, fetchImpl }));
      stages.siwe = siwe.summary;
      authedWorker = new AgentPlatformClient({ baseUrl: config.apiBaseUrl, token: siwe.token, fetchImpl });
    }

    // ── STAGE 2: authed read (guards #626 JWT sub-casing 401) ─────────────
    stages.account = await stage("account", () => runAccountStage({ authedWorker, workerAddress }));

    // ── STAGE 3: claim (guards claim 409 + claimJobFor brokering) ─────────
    const claim = await stage("claim", () =>
      runClaimStage({ authedWorker, jobId, workerAddress, idempotencyKey: `worker-canary:${jobId}`, before })
    );
    stages.claim = claim.summary;
    const sessionId = claim.sessionId;
    captureTxHash(txHashes, "claim", claim.raw);

    // ── STAGE 4: submit (guards #627 submitWorkFor revert) ────────────────
    const submit = await stage("submit", () =>
      runSubmitStage({ authedWorker, sessionId, jobId, timestamp: startedAt })
    );
    stages.submit = submit.summary;
    captureTxHash(txHashes, "submit", submit.raw);

    // chainJobId comes from the worker's own session record
    const chainJobId = await resolveChainJobId({ authedWorker, sessionId, claim, submit });

    // ── STAGE 5: verify (operator path until auto-verify lands) ───────────
    const verify = await stage("verify", () =>
      runVerifyStage({ operatorPlatform, authedWorker, sessionId, mode: config.verifyMode })
    );
    stages.verify = verify.summary;
    captureTxHash(txHashes, "verify", verify.raw);

    // ── wait for settlement to land, then STAGE 6 assertions ──────────────
    const settle = await stage("settle", () =>
      runSettleStage({
        reader,
        authedWorker,
        sessionId,
        chainJobId,
        workerAddress,
        before,
        rewardRaw: config.rewardRaw,
        settleTimeoutMs: config.settleTimeoutMs,
        settlePollMs: config.settlePollMs,
        now,
        log
      })
    );
    stages.settle = settle.summary;

    // ── STAGE 7: operator token freshness (guards #628 ADMIN_JWT expiry) ──
    // Run last: let the loop prove itself, then flag an about-to-expire
    // long-lived operator credential before it silently 401s every smoke.
    stages.tokenFreshness = assertOperatorTokenFreshness({ operatorAuth, minDays: config.tokenMinDays, now });

    const evidence = {
      proof: "worker-canary",
      apiBaseUrl: config.apiBaseUrl,
      profile: config.profile,
      chainId: chainId.toString(),
      workerWallet: workerAddress,
      workerEphemeral: config.workerEphemeral,
      operatorAuthMode: operatorAuth.mode,
      jobId,
      sessionId,
      chainJobId,
      reward: { amount: config.rewardAmount, raw: config.rewardRaw.toString(), asset: DEFAULT_ESCROW_ASSET.symbol },
      stages,
      txHashes,
      timings: { ...timings, totalMs: now() - startedAt },
      cleanup: { jobArchived: false, jobKept: false },
      checkedAt: new Date(startedAt).toISOString()
    };

    // Archive the disposable job so canary jobs never accumulate (unless the
    // operator asked to keep it). Either way, cleanup is handled — suppress the
    // finally retry.
    const didArchive = await archiveCanaryJob({ operatorPlatform, jobId, config, log });
    archived = true;
    evidence.cleanup.jobArchived = didArchive;
    evidence.cleanup.jobKept = !didArchive;
    createdJobId = null;

    if (config.evidenceFile) {
      await mkdir(dirname(config.evidenceFile), { recursive: true });
      await writeFile(config.evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      log(`Wrote worker-canary evidence to ${config.evidenceFile}`);
    }

    log(
      `Worker canary PASSED — roleless ${workerAddress} walked SIWE→claim→submit→verify→settle; ` +
        `released ${settle.summary.released} ${DEFAULT_ESCROW_ASSET.symbol}, ` +
        `worker credited ${settle.summary.creditedRaw} base units.`
    );
    return evidence;
  } finally {
    // Best-effort cleanup if we created a job but bailed before archiving it.
    if (createdJobId && !archived) {
      try {
        await archiveCanaryJob({ operatorPlatform, jobId: createdJobId, config, log });
        log(`Archived stranded canary job ${createdJobId} during cleanup.`);
      } catch (cleanupError) {
        log(`WARNING: failed to archive canary job ${createdJobId}: ${cleanupError?.message ?? cleanupError}`);
      }
    }
  }
}

// ── STAGE 1: SIWE ───────────────────────────────────────────────────────────
export async function runSiweStage({
  apiBaseUrl,
  wallet,
  fetchImpl,
  anonClient = new AgentPlatformClient({ baseUrl: apiBaseUrl, token: undefined, fetchImpl })
}) {
  const anon = anonClient;

  const nonce = await anon.issueNonce(wallet.address);
  const message = nonce?.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("SIWE stage: /auth/nonce did not return a non-empty SIWE message.");
  }

  const signature = await wallet.signMessage(message);

  let verify;
  try {
    verify = await anon.verifySignature(message, signature);
  } catch (error) {
    if (error?.status === 500) {
      throw new Error(
        `SIWE stage FAILED at /auth/verify with HTTP 500 (${describeApiError(error)}). ` +
          "This is the roleless-wallet SIWE→JWT mint regression (#625): the ES256 sign path " +
          "rejected a roleless worker token. EVERY external agent is locked out at the front door."
      );
    }
    if (error?.status === 401) {
      throw new Error(
        `SIWE stage FAILED at /auth/verify with HTTP 401 (${describeApiError(error)}). ` +
          "The freshly-signed SIWE signature was rejected — the front door is broken for new wallets."
      );
    }
    throw error;
  }

  const token = verify?.token;
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("SIWE stage: /auth/verify did not return a JWT bearer token.");
  }
  const roles = Array.isArray(verify?.roles) ? verify.roles : [];
  if (roles.length !== 0) {
    throw new Error(
      `SIWE stage: canary worker must be ROLELESS, but /auth/verify returned roles ${JSON.stringify(roles)}. ` +
        "Use a dedicated roleless wallet — never the admin/verifier identity."
    );
  }
  return {
    token,
    summary: { mode: "live", status: 200, roleless: true, expiresAt: verify?.expiresAt ?? null }
  };
}

// ── STAGE 2: authed read ────────────────────────────────────────────────────
export async function runAccountStage({ authedWorker, workerAddress }) {
  let account;
  try {
    account = await authedWorker.getAccountSummary();
  } catch (error) {
    if (error?.status === 401) {
      const code = error?.payload?.error ?? error?.payload?.code ?? "";
      throw new Error(
        `Account stage FAILED: GET /account returned HTTP 401 (${describeApiError(error)}). ` +
          (String(code).includes("claims_mismatch") || code === ""
            ? "This is the JWT sub-casing regression (#626): the SIWE-minted token's `sub` does not pass " +
              "the verifier's own check (checksummed vs lowercase). The worker's freshly-minted token is unusable."
            : "The worker's freshly-minted token was rejected on a base, non-role-gated route.")
      );
    }
    throw error;
  }
  if (account?.wallet && account.wallet.toLowerCase() !== workerAddress.toLowerCase()) {
    throw new Error(
      `Account stage: /account wallet ${account.wallet} does not match the SIWE worker ${workerAddress}.`
    );
  }
  return { status: 200, wallet: account?.wallet ?? workerAddress };
}

// ── STAGE 3: claim ──────────────────────────────────────────────────────────
export async function runClaimStage({ authedWorker, jobId, workerAddress, idempotencyKey, before }) {
  const preflight = await authedWorker.preflightJob(jobId);
  if (!preflight || preflight.jobId !== jobId) {
    throw new Error(`Claim stage: /jobs/preflight job id mismatch: expected ${jobId}, got ${preflight?.jobId ?? "missing"}.`);
  }
  if (preflight.eligible !== true || preflight.claimable !== true || preflight.currentWalletCanClaim === false) {
    throw new Error(
      `Claim stage: preflight says the worker cannot claim — eligible=${String(preflight.eligible)}; ` +
        `claimable=${String(preflight.claimable)}; currentWalletCanClaim=${String(preflight.currentWalletCanClaim)}; ` +
        `reason=${preflight.reason ?? "none"}. A funded, claimable canary job should always be claimable by a fresh worker.`
    );
  }

  // The claim must be payable: EITHER the fresh-wallet onboarding waiver still
  // applies, OR the worker is pre-funded enough to cover the claim lock. If
  // neither holds, the claim would 409 insufficient_liquidity — the exact bug.
  const waived = preflight.claimEconomicsWaived === true;
  const totalClaimLock = preflight.totalClaimLock ?? null;
  const lockRaw = totalClaimLock === null ? 0n : toBaseUnits(totalClaimLock);
  let mechanism;
  if (waived || lockRaw === 0n) {
    mechanism = "onboarding_waiver";
  } else {
    // Pre-funded path: the worker's liquid position must cover the lock. This
    // is operator-assisted today (the operator tops the worker up out of band);
    // it becomes a no-op once auto-fund lands.
    const liquid = before.aacLiquidRaw;
    if (liquid < lockRaw) {
      throw new Error(
        `Claim stage WOULD 409 (insufficient_liquidity): the fresh-wallet onboarding waiver is exhausted ` +
          `(claimEconomicsWaived=false) and the worker is underfunded — totalClaimLock=${lockRaw} base units, ` +
          `worker AAC liquid=${liquid} base units. Pre-fund the canary worker's AgentAccountCore position with ` +
          `≥ the claim lock, or rotate to a wallet still within its onboarding waiver. ` +
          "(Guards the claim-funding 409 class + claimJobFor brokering.)"
      );
    }
    mechanism = "prefunded";
  }

  let claim;
  try {
    claim = await authedWorker.claimJob(jobId, idempotencyKey);
  } catch (error) {
    if (error?.status === 409) {
      if (isEnsureJobRevert(error)) {
        throw new Error(
          `Claim stage FAILED during canary job funding/setup: /jobs/claim returned HTTP 409 (${describeApiError(error)}). ` +
            "The disposable canary job is created in the API first and funded on-chain by ensureJob during claim; " +
            "ensureJob reverted before claimJobFor could run. Check /admin/status for signerFunding, " +
            "EscrowCore.accounts() -> AgentAccountCore binding, service-operator grants, and asset approval. " +
            `mechanism=${mechanism}; totalClaimLock=${lockRaw}.`
        );
      }
      throw new Error(
        `Claim stage FAILED: /jobs/claim returned HTTP 409 (${describeApiError(error)}). ` +
          "This is the claim-funding 409 class: the brokered on-chain claimJobFor could not lock the claim " +
          "(backend signer underfunded, or stake/fee not waived for this worker). " +
          `mechanism=${mechanism}; totalClaimLock=${lockRaw}.`
      );
    }
    throw error;
  }
  const sessionId = claim?.sessionId;
  if (!sessionId) {
    throw new Error(`Claim stage: /jobs/claim succeeded but returned no sessionId (${JSON.stringify(claim)}).`);
  }
  return {
    sessionId,
    raw: claim,
    summary: {
      status: claim.status ?? "claimed",
      sessionId,
      mechanism,
      claimEconomicsWaived: waived,
      totalClaimLockRaw: lockRaw.toString()
    }
  };
}

// ── STAGE 4: submit ─────────────────────────────────────────────────────────
export async function runSubmitStage({ authedWorker, sessionId, jobId, timestamp }) {
  const submission = buildCanarySubmission({ jobId, timestamp });
  let submit;
  try {
    submit = await authedWorker.submitWork(sessionId, submission);
  } catch (error) {
    if (isBlockchainRevert(error)) {
      throw new Error(
        `Submit stage FAILED: /jobs/submit reverted on-chain (${describeApiError(error)}). ` +
          "This is the submitWork revert class (#627): the operator-brokered submitWorkFor path is missing or broken. " +
          "Re-check the EscrowCore redeploy and that the backend signer is a registered service operator."
      );
    }
    throw error;
  }
  if (submit?.status !== "submitted") {
    throw new Error(
      `Submit stage: expected status "submitted", got "${submit?.status ?? "missing"}" (${JSON.stringify(submit)}).`
    );
  }
  // A 200 with an embedded revert/local-only chain status is still a failure.
  const chainStatus = submit?.chainStatus ?? submit?.verification?.chainStatus;
  if (chainStatus === "reverted" || submit?.blockchain_revert === true) {
    throw new Error(
      `Submit stage FAILED: /jobs/submit returned status=submitted but chainStatus=${chainStatus}. ` +
        "The brokered submitWorkFor did not land on-chain (#627 class)."
    );
  }
  return { raw: submit, summary: { status: submit.status, chainStatus: chainStatus ?? null } };
}

// ── STAGE 5: verify ─────────────────────────────────────────────────────────
export async function runVerifyStage({ operatorPlatform, authedWorker, sessionId, mode }) {
  // mode "auto" lets the canary become a no-op verifier once a scheduler
  // auto-verifies submitted benchmark jobs: it polls the public result instead
  // of operator-triggering. Default "operator" triggers the verify itself.
  if (mode === "auto") {
    const result = await authedWorker.getVerifierResult(sessionId);
    const outcome = result?.outcome ?? result?.verification?.status;
    if (outcome !== "approved" && outcome !== "passed") {
      throw new Error(
        `Verify stage (auto): expected an "approved" auto-verification, got "${outcome ?? "missing"}". ` +
          "Auto-verify has not approved this submission."
      );
    }
    return { raw: result, summary: { mode: "auto", outcome: "approved", reasonCode: result?.reasonCode ?? null } };
  }

  const verification = await operatorPlatform.runVerifier(sessionId);
  const outcome = verification?.outcome ?? verification?.status;
  if (outcome !== "approved") {
    throw new Error(
      `Verify stage FAILED: operator /verifier/run returned outcome "${outcome ?? "missing"}", expected "approved". ` +
        `reasonCode=${verification?.reasonCode ?? "none"}.`
    );
  }
  return {
    raw: verification,
    summary: { mode: "operator", outcome, reasonCode: verification?.reasonCode ?? null }
  };
}

// ── STAGE 6: settle ─────────────────────────────────────────────────────────
export async function runSettleStage({
  reader,
  authedWorker,
  sessionId,
  chainJobId,
  workerAddress,
  before,
  rewardRaw,
  settleTimeoutMs,
  settlePollMs,
  now,
  log
}) {
  // Wait until either the session resolves or the chain job closes.
  const deadline = now() + settleTimeoutMs;
  let job = await reader.readEscrowJob(chainJobId);
  let session = await safeGetSession(authedWorker, sessionId);
  while (Number(job.state) !== JOB_STATE.Closed && session?.status !== "resolved" && now() < deadline) {
    await sleep(settlePollMs);
    job = await reader.readEscrowJob(chainJobId);
    session = await safeGetSession(authedWorker, sessionId);
    log(`Settling… session=${session?.status ?? "?"} jobState=${jobStateName(job.state)}`);
  }

  if (Number(job.state) !== JOB_STATE.Closed) {
    throw new Error(
      `Settle stage FAILED: EscrowCore job ${chainJobId} is "${jobStateName(job.state)}", not "Closed", after ` +
        `${Math.round(settleTimeoutMs / 1000)}s. The verified job never settled on-chain ` +
        "(verification approved but no release / payout). This is the settlement-stall class."
    );
  }
  if (job.releasedRaw !== rewardRaw) {
    throw new Error(
      `Settle stage FAILED: EscrowCore released ${job.releasedRaw} base units but reward was ${rewardRaw}. ` +
        "Released amount must equal the full reward on a benchmark approval."
    );
  }
  if (job.worker && job.worker.toLowerCase() !== workerAddress.toLowerCase()) {
    throw new Error(
      `Settle stage: EscrowCore job worker ${job.worker} does not match the canary worker ${workerAddress}.`
    );
  }

  // Where did the money actually land? This run's payout credits the EOA; a
  // future settle-into-position would credit AAC.liquid. Check BOTH and require
  // the reward to show up in one of them — so the canary stays green across the
  // P1 "earnings → spendable-balance" reconciliation either way.
  const after = await reader.snapshotWorker(workerAddress);
  const eoaDelta = after.usdcRaw - before.usdcRaw;
  const aacLiquidDelta = after.aacLiquidRaw - before.aacLiquidRaw;
  const creditedRaw = eoaDelta + aacLiquidDelta;
  if (creditedRaw < rewardRaw) {
    throw new Error(
      `Settle stage FAILED: job Closed and released ${rewardRaw} base units, but the worker's balance did not rise ` +
        `by the reward. usdc.balanceOf delta=${eoaDelta}; AAC.positions.liquid delta=${aacLiquidDelta}; ` +
        `total credited=${creditedRaw}; expected ≥ ${rewardRaw}. The reward settled but never reached the worker.`
    );
  }

  return {
    summary: {
      jobState: "Closed",
      released: formatBaseUnits(job.releasedRaw),
      releasedRaw: job.releasedRaw.toString(),
      sessionStatus: session?.status ?? null,
      eoaDeltaRaw: eoaDelta.toString(),
      aacLiquidDeltaRaw: aacLiquidDelta.toString(),
      creditedRaw: creditedRaw.toString(),
      creditedTo: eoaDelta >= rewardRaw ? "worker_eoa" : aacLiquidDelta >= rewardRaw ? "aac_liquid" : "split"
    }
  };
}

// ── STAGE 7: operator token freshness ────────────────────────────────────────
export function assertOperatorTokenFreshness({ operatorAuth, minDays, now }) {
  const mode = operatorAuth?.mode ?? "unknown";
  const token = operatorAuth?.token;
  const exp = token ? decodeJwtExpSeconds(token) : null;
  const nowMs = now();
  const daysToExpiry = exp === null ? null : (exp * 1000 - nowMs) / 86_400_000;

  // Short-lived, self-rotating operator tokens (the refresh flow, #529) don't
  // belong to the ADMIN_JWT-calendar-expiry class — they're minted per run and
  // rotated automatically. The days-from-expiry guard is N/A for them, so it
  // becomes a no-op once the refresh flow lands.
  const longLived = mode === "legacy_admin_jwt";
  if (!longLived) {
    return {
      mode,
      enforced: false,
      reason: "operator token is short-lived/self-rotating; expiry-class guard N/A",
      expiresAt: exp === null ? null : new Date(exp * 1000).toISOString(),
      daysToExpiry: daysToExpiry === null ? null : round1(daysToExpiry)
    };
  }

  if (exp === null) {
    throw new Error(
      "Token-freshness stage FAILED: the long-lived operator ADMIN_JWT has no `exp` claim, so its calendar expiry " +
        "cannot be guarded. This is the ADMIN_JWT-expiry class (#628) — mint a token with a bounded expiry."
    );
  }
  if (daysToExpiry < minDays) {
    throw new Error(
      `Token-freshness stage FAILED: the operator ADMIN_JWT expires in ${round1(daysToExpiry)} day(s) ` +
        `(< ${minDays}-day threshold), at ${new Date(exp * 1000).toISOString()}. ` +
        "Rotate it now — once it expires, every hosted smoke/proof silently 401s. (Guards #628.)"
    );
  }
  return {
    mode,
    enforced: true,
    thresholdDays: minDays,
    expiresAt: new Date(exp * 1000).toISOString(),
    daysToExpiry: round1(daysToExpiry)
  };
}

// ── operator readiness ───────────────────────────────────────────────────────
export async function assertOperatorReady(operatorPlatform, { rewardRaw = undefined, rewardAssetSymbol = DEFAULT_ESCROW_ASSET.symbol } = {}) {
  const authSession = await operatorPlatform.getAuthSession();
  const capabilities = Array.isArray(authSession?.capabilities) ? authSession.capabilities : [];
  const missing = REQUIRED_OPERATOR_CAPABILITIES.filter((cap) => !capabilities.includes(cap));
  if (missing.length > 0) {
    throw new Error(
      `Operator readiness FAILED: the operator token is missing capabilities [${missing.join(", ")}]. ` +
        "The canary needs an admin+verifier token to create, verify, and archive the disposable job. " +
        `roles=${(authSession?.roles ?? []).join(",") || "none"}.`
    );
  }

  const status = await operatorPlatform.getAdminStatus();
  const policy = status?.maintenance?.policy;
  if (!policy?.enabled) {
    throw new Error(
      "Operator readiness FAILED: on-chain settlement is not ready (/admin/status). " +
        `enabled=${String(policy?.enabled)}; settlementReady=${String(policy?.settlementReady)}. ` +
        "Brokered claim/submit/settle cannot complete."
    );
  }
  if (policy.roles?.escrowIsServiceOperator !== true) {
    throw new Error(
      "Operator readiness FAILED: the backend signer is not a registered EscrowCore service operator, so the " +
        "brokered claimJobFor/submitWorkFor path is disabled. (This is what #627 + the EscrowCore redeploy fixed.)"
    );
  }
  if (policy.roles?.escrowIsAgentAccountEscrowOperator !== true) {
    throw new Error(
      "Operator readiness FAILED: EscrowCore is not an AgentAccountCore escrow operator, so claim-stake and settlement " +
        "ledger mutations are disabled. Run the EscrowCore multisig wiring recipe before the canary."
    );
  }
  if (policy.roles?.escrowAgentAccountMatchesConfig === false) {
    throw new Error(
      "Operator readiness FAILED: EscrowCore.accounts() does not match the configured AgentAccountCore. " +
        `escrowCore=${policy.contracts?.escrowCoreAddress ?? "unknown"}; ` +
        `EscrowCore.accounts=${policy.contracts?.escrowCoreAgentAccountAddress ?? "unknown"}; ` +
        `configured AgentAccountCore=${policy.contracts?.agentAccountAddress ?? "unknown"}. ` +
        "The backend may read signer liquidity from one AgentAccountCore while EscrowCore reserves from another, " +
        "which makes ensureJob revert during canary claim setup."
    );
  }
  const fundingAsset = Array.isArray(policy.signerFunding?.assets)
    ? policy.signerFunding.assets.find((asset) => asset?.symbol === rewardAssetSymbol)
    : undefined;
  if (fundingAsset) {
    if (fundingAsset.readable !== true) {
      throw new Error(
        `Operator readiness FAILED: signer reward-bank position for ${rewardAssetSymbol} is not readable from ` +
          `AgentAccountCore ${policy.signerFunding?.agentAccountAddress ?? policy.contracts?.agentAccountAddress ?? "unknown"}. ` +
          "The canary cannot prove the disposable job can be funded."
      );
    }
    const liquidRaw = BigInt(fundingAsset.liquidRaw ?? 0);
    if (rewardRaw !== undefined && liquidRaw < BigInt(rewardRaw)) {
      throw new Error(
        `Operator readiness FAILED: signer reward bank is underfunded for ${rewardAssetSymbol}. ` +
          `liquid=${liquidRaw} raw (${fundingAsset.liquid ?? "unknown"} ${rewardAssetSymbol}); ` +
          `required=${rewardRaw} raw (${formatBaseUnits(rewardRaw)} ${rewardAssetSymbol}). ` +
          "Deposit reward liquidity into AgentAccountCore before running the worker canary."
      );
    }
  }
  if (policy.settlementReady !== true) {
    throw new Error(
      "Operator readiness FAILED: on-chain settlement is not ready (/admin/status). " +
        `enabled=${String(policy?.enabled)}; settlementReady=${String(policy?.settlementReady)}. ` +
        "Brokered claim/submit/settle cannot complete."
    );
  }
  return {
    capabilities: REQUIRED_OPERATOR_CAPABILITIES,
    settlementReady: true,
    escrowIsServiceOperator: true,
    escrowIsAgentAccountEscrowOperator: true,
    escrowAgentAccountMatchesConfig: policy.roles?.escrowAgentAccountMatchesConfig,
    signerFundingChecked: Boolean(fundingAsset)
  };
}

// ── disposable job + submission shape ─────────────────────────────────────────
function buildCanaryJob({ jobId, rewardAmount }) {
  return {
    id: jobId,
    title: "External-worker CI canary (disposable, proof-only)",
    category: "coding",
    tier: "starter",
    rewardAsset: DEFAULT_ESCROW_ASSET.symbol,
    rewardAmount: Number(rewardAmount),
    verifierMode: "benchmark",
    verifierTerms: VERIFIER_TERMS,
    verifierMinimumMatches: 2,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true,
    claimTtlSeconds: 3600,
    retryLimit: 1,
    outputSchemaRef: OUTPUT_SCHEMA_REF
  };
}

function buildCanarySubmission({ jobId, timestamp }) {
  const completedAt = new Date(timestamp).toISOString();
  const evidence = `complete verified output for ${jobId}`;
  return {
    summary: evidence,
    output: evidence,
    status: "complete",
    job_id: jobId,
    completed_at: completedAt,
    checks: [
      { name: "worker_output", status: "pass", evidence },
      { name: "schema_contract", status: "pass", evidence: `Submission targets ${OUTPUT_SCHEMA_REF}.` }
    ]
  };
}

async function archiveCanaryJob({ operatorPlatform, jobId, config, log }) {
  if (config.keepJob) {
    log(`WORKER_CANARY_KEEP_JOB set — leaving canary job ${jobId} live (no archive).`);
    return false;
  }
  await operatorPlatform.request("/admin/jobs/lifecycle", {
    method: "POST",
    body: { jobId, action: "archive", reason: "worker-canary cleanup" }
  });
  return true;
}

// ── chain reader (ethers) ─────────────────────────────────────────────────────
function buildChainReader(config) {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const usdc = new Contract(config.assetAddress, ERC20_BALANCE_ABI, provider);
  const aac = new Contract(config.agentAccountAddress, AGENT_ACCOUNT_ABI, provider);
  const escrow = new Contract(config.escrowAddress, ESCROW_CORE_ABI, provider);
  return {
    async getChainId() {
      const network = await provider.getNetwork();
      return network.chainId;
    },
    async snapshotWorker(workerAddress) {
      const [usdcRaw, position] = await Promise.all([
        usdc.balanceOf(workerAddress),
        aac.positions(workerAddress, config.assetAddress)
      ]);
      return { usdcRaw: BigInt(usdcRaw), aacLiquidRaw: BigInt(position.liquid ?? position[0]) };
    },
    async readEscrowJob(chainJobId) {
      const job = await escrow.jobs(chainJobId);
      return {
        state: Number(job.state),
        releasedRaw: BigInt(job.released),
        rewardRaw: BigInt(job.reward),
        worker: job.worker
      };
    }
  };
}

// ── config + helpers ──────────────────────────────────────────────────────────
function parseConfig(env) {
  const apiBaseUrl = stripTrailingSlash(pick(env.API_BASE_URL) || DEFAULT_API_BASE_URL);
  const profile = pick(env.WORKER_CANARY_PROFILE) || DEFAULT_PROFILE;
  const deployment = loadDeployment(profile);
  const rewardAmount = pick(env.WORKER_CANARY_REWARD_AMOUNT) || DEFAULT_REWARD_AMOUNT;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(rewardAmount) || Number(rewardAmount) <= 0) {
    throw new Error(`WORKER_CANARY_REWARD_AMOUNT must be a positive decimal; got ${JSON.stringify(rewardAmount)}.`);
  }
  return {
    apiBaseUrl,
    profile,
    rpcUrl: pick(env.WORKER_CANARY_RPC_URL) || deployment.rpcUrl,
    assetAddress: DEFAULT_ESCROW_ASSET.address,
    agentAccountAddress: deployment.contracts.agentAccountCore,
    escrowAddress: deployment.contracts.escrowCore,
    rewardAmount,
    rewardRaw: toBaseUnits(rewardAmount),
    tokenMinDays: parsePositiveInt(env.WORKER_CANARY_TOKEN_MIN_DAYS, DEFAULT_TOKEN_MIN_DAYS),
    settleTimeoutMs: parsePositiveInt(env.WORKER_CANARY_SETTLE_TIMEOUT_MS, DEFAULT_SETTLE_TIMEOUT_MS),
    settlePollMs: parsePositiveInt(env.WORKER_CANARY_SETTLE_POLL_MS, DEFAULT_SETTLE_POLL_MS),
    jobId: pick(env.WORKER_CANARY_JOB_ID),
    verifyMode: pick(env.WORKER_CANARY_VERIFY_MODE) === "auto" ? "auto" : "operator",
    keepJob: enabled(env.WORKER_CANARY_KEEP_JOB),
    evidenceFile: pick(env.WORKER_CANARY_EVIDENCE_FILE),
    workerEphemeral: false, // set during wallet resolution
    injectedOperatorToken: pick(env.WORKER_CANARY_OPERATOR_TOKEN) || undefined
  };
}

function loadDeployment(profile) {
  if (profile !== DEFAULT_PROFILE) {
    // Hard fail-closed: the canary is a TESTNET-only instrument. A non-testnet
    // profile must never be loaded, even before we read the live chainId.
    throw new Error(
      `Worker canary refuses to run with profile "${profile}". This canary is testnet-only ` +
        `(${DEFAULT_PROFILE}); it must never drive a paid loop against mainnet.`
    );
  }
  const file = resolve(repoRoot, "deployments", `${profile}.json`);
  const deployment = JSON.parse(readFileSync(file, "utf8"));
  if (deployment.profile !== DEFAULT_PROFILE) {
    throw new Error(`deployments/${profile}.json declares profile "${deployment.profile}", expected "${DEFAULT_PROFILE}".`);
  }
  if (!deployment.rpcUrl || !deployment.contracts?.escrowCore || !deployment.contracts?.agentAccountCore) {
    throw new Error(`deployments/${profile}.json is missing rpcUrl / escrowCore / agentAccountCore.`);
  }
  return deployment;
}

function assertTestnet({ chainId, profile }) {
  if (profile !== DEFAULT_PROFILE) {
    throw new Error(`Worker canary chain-env gate: profile "${profile}" is not "${DEFAULT_PROFILE}".`);
  }
  if (BigInt(chainId) !== EXPECTED_TESTNET_CHAIN_ID) {
    throw new Error(
      `Worker canary chain-env gate: live chainId ${chainId} is not Polkadot Hub TestNet ` +
        `(${EXPECTED_TESTNET_CHAIN_ID}). Refusing to run — this canary must never touch mainnet.`
    );
  }
}

async function resolveWorkerWallet({ env, config, readSecretImpl, log }) {
  const explicit = pick(env.WORKER_CANARY_WORKER_PRIVATE_KEY);
  if (explicit) {
    return new Wallet(explicit);
  }
  const opRef = pick(env.WORKER_CANARY_WORKER_KEY_OP) || DEFAULT_WORKER_KEY_OP;
  try {
    const key = (await readSecretImpl(opRef)).trim();
    if (key) {
      return new Wallet(key);
    }
  } catch (error) {
    if (!enabled(env.WORKER_CANARY_ALLOW_EPHEMERAL)) {
      throw new Error(
        `Could not read the canary worker key from ${opRef} (${error?.message ?? error}). ` +
          "Provision it (rotate-admin-generate-key.mjs --out ... then store the private key there), " +
          "set WORKER_CANARY_WORKER_PRIVATE_KEY, or set WORKER_CANARY_ALLOW_EPHEMERAL=1 for local dev."
      );
    }
  }
  if (enabled(env.WORKER_CANARY_ALLOW_EPHEMERAL)) {
    log("WORKER_CANARY_ALLOW_EPHEMERAL set — using a throwaway random worker wallet (local dev only).");
    config.workerEphemeral = true;
    return Wallet.createRandom();
  }
  throw new Error(
    `No canary worker key available. Set WORKER_CANARY_WORKER_PRIVATE_KEY, provision ${opRef}, ` +
      "or set WORKER_CANARY_ALLOW_EPHEMERAL=1 for local dev."
  );
}

async function resolveChainJobId({ authedWorker, sessionId, claim, submit }) {
  const direct = claim?.chainJobId ?? submit?.chainJobId;
  if (typeof direct === "string" && /^0x[a-fA-F0-9]{64}$/u.test(direct)) {
    return direct;
  }
  const session = await safeGetSession(authedWorker, sessionId);
  const chainJobId = session?.chainJobId;
  if (typeof chainJobId !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(chainJobId)) {
    throw new Error(
      `Could not resolve a chainJobId for session ${sessionId} — needed to read on-chain settlement state. ` +
        `got ${chainJobId ?? "missing"}.`
    );
  }
  return chainJobId;
}

async function safeGetSession(authedWorker, sessionId) {
  try {
    return await authedWorker.getSession(sessionId);
  } catch {
    return undefined;
  }
}

function captureTxHash(txHashes, stage, raw) {
  const candidate = raw?.txHash ?? raw?.transactionHash ?? raw?.verification?.txHash;
  if (typeof candidate === "string" && /^0x[a-fA-F0-9]{64}$/u.test(candidate)) {
    txHashes[stage] = candidate;
  }
}

function isBlockchainRevert(error) {
  if (!error) return false;
  const code = String(error?.payload?.error ?? error?.payload?.code ?? "").toLowerCase();
  const message = String(error?.payload?.message ?? error?.message ?? "").toLowerCase();
  if (error.status === 500 && (code.includes("revert") || message.includes("revert"))) return true;
  return code.includes("blockchain_revert") || message.includes("execution reverted");
}

const JOB_STATE = { None: 0, Open: 1, Claimed: 2, Submitted: 3, Rejected: 4, Disputed: 5, Closed: 6 };
function jobStateName(state) {
  const n = Number(state);
  return Object.keys(JOB_STATE).find((k) => JOB_STATE[k] === n) ?? `Unknown(${state})`;
}

function decodeJwtExpSeconds(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? Number(payload.exp) : null;
  } catch {
    return null;
  }
}

// USDC has 6 decimals (DEFAULT_ESCROW_ASSET.decimals). Decimal-string → base units.
function toBaseUnits(amount) {
  const decimals = DEFAULT_ESCROW_ASSET.decimals;
  const normalized = String(amount).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(normalized)) {
    throw new Error(`amount must be a positive decimal; got ${JSON.stringify(amount)}.`);
  }
  const [whole, fractional = ""] = normalized.split(".");
  if (fractional.length > decimals) {
    throw new Error(`amount must fit ${decimals} decimal places; got ${normalized}.`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractional.padEnd(decimals, "0") || "0");
}

function formatBaseUnits(raw) {
  const decimals = DEFAULT_ESCROW_ASSET.decimals;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fractional = value % scale;
  if (fractional === 0n) return whole.toString();
  return `${whole}.${fractional.toString().padStart(decimals, "0").replace(/0+$/u, "")}`;
}

function describeApiError(error) {
  const code = error?.payload?.error ?? error?.payload?.code ?? "";
  const message = error?.payload?.message ?? error?.message ?? "";
  const requestId = error?.payload?.requestId ? `; requestId=${error.payload.requestId}` : "";
  return `status=${error?.status ?? "?"}; code=${code || "?"}; message=${message}${requestId}`;
}

function isEnsureJobRevert(error) {
  const code = String(error?.payload?.error ?? error?.payload?.code ?? "");
  const message = String(error?.payload?.message ?? error?.message ?? "");
  return code === "blockchain_revert" || /ensureJob failed|require\(false\)/iu.test(message);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(value) {
  return typeof value === "string" ? value.trim() : "";
}

function enabled(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const raw = pick(typeof value === "string" ? value : value === undefined ? "" : String(value));
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`expected a positive integer; got ${JSON.stringify(value)}.`);
  }
  return n;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkerCanary()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    });
}
