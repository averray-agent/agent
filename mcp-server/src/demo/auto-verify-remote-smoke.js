// Live smoke for the submitted-job auto-verifier (GO_LIVE_PUNCHLIST P0).
//
// Proves the self-sustaining loop end-to-end against a deployed backend that
// has AUTO_VERIFY_ENABLED=1: create a benchmark job, claim it, submit work, and
// then WAIT — without ever calling /verifier/run — for the backend's scheduler
// to verify + settle the submission on its own. Asserts the session reaches
// `resolved` and that the worker wallet's liquid reward balance rises.
//
// Contrast with e2e-remote.js, which drives the verification manually via
// POST /verifier/run. This script deliberately omits that call: if the session
// settles, auto-verify did it.
//
// Usage (against the testnet backend):
//   REMOTE_E2E_BASE_URL=https://<backend> \
//   REMOTE_E2E_PRIVATE_KEY=0x<worker-eoa-key> \
//   AUTO_VERIFY_SMOKE_REWARD_ASSET=DOT \
//   node src/demo/auto-verify-remote-smoke.js
//
// The signing wallet must be allowed to POST /admin/jobs (AUTH_ADMIN_WALLETS)
// on a strict deployment. The backend — not this script — must hold the
// verifier role and run the scheduler; this caller never needs it.

import { Wallet } from "ethers";
import { loginTestWallet } from "./auth-helper.js";

const DEFAULT_BASE_URL = "https://api.averray.com";
const DEFAULT_WALLET = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 5_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(baseUrl, path, init = undefined) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${payload?.message ?? payload?.error ?? "unknown_error"}`);
  }
  return payload;
}

function liquidBalance(account, asset) {
  const liquid = account?.liquid ?? {};
  const raw = liquid[asset] ?? liquid[asset?.toUpperCase?.()] ?? 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const baseUrl = (process.env.REMOTE_E2E_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const privateKey = process.env.REMOTE_E2E_PRIVATE_KEY;
  const legacyWallet = process.env.REMOTE_E2E_WALLET ?? DEFAULT_WALLET;
  const rewardAsset = (process.env.AUTO_VERIFY_SMOKE_REWARD_ASSET ?? "DOT").trim();
  const rewardAmount = Number(process.env.AUTO_VERIFY_SMOKE_REWARD_AMOUNT ?? 6);
  const timeoutMs = Number(process.env.AUTO_VERIFY_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const pollMs = Number(process.env.AUTO_VERIFY_SMOKE_POLL_MS ?? DEFAULT_POLL_MS);
  const timestamp = Date.now();
  const jobId = `auto-verify-smoke-${timestamp}`;
  const evidence = `complete verified output for ${jobId}`;

  console.log(`Base URL: ${baseUrl}`);

  const health = await readJson(baseUrl, "/health");
  assert(health.status === "ok", `Expected healthy API, got ${health.status}`);
  const authMode = health.auth?.mode ?? "unknown";
  console.log(`Auth mode: ${authMode}`);

  let wallet = legacyWallet;
  let authHeader = {};
  if (privateKey) {
    const signed = await loginTestWallet({ baseUrl, privateKey });
    wallet = signed.wallet;
    authHeader = signed.authHeader;
    console.log(`Signed in as ${wallet} (token expires ${signed.expiresAt})`);
  } else {
    if (authMode !== "permissive") {
      throw new Error(
        "REMOTE_E2E_PRIVATE_KEY is required when the API is not in permissive mode. " +
          "Set it to an ethers-compatible hex private key for the worker wallet."
      );
    }
    try {
      wallet = new Wallet(legacyWallet).address; // eslint-disable-line no-new
    } catch {
      // legacyWallet is already an address, not a private key — use as-is.
    }
    console.log(`Wallet (permissive, unsigned): ${wallet}`);
  }

  console.log(`Job: ${jobId} (reward ${rewardAmount} ${rewardAsset})`);

  const before = await readJson(baseUrl, "/account", { headers: { ...authHeader } });
  const startingBalance = liquidBalance(before, rewardAsset);
  console.log(`Worker ${rewardAsset} liquid balance before: ${startingBalance}`);

  const createdJob = await readJson(baseUrl, "/admin/jobs", {
    method: "POST",
    headers: { ...authHeader },
    body: JSON.stringify({
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
      outputSchemaRef: "schema://jobs/auto-verify-smoke-output"
    })
  });
  assert(createdJob.id === jobId, `Expected created job id ${jobId}, got ${createdJob.id}`);

  const walletQs = `wallet=${encodeURIComponent(wallet)}`;

  const claim = await readJson(
    baseUrl,
    `/jobs/claim?${walletQs}&jobId=${encodeURIComponent(jobId)}&idempotencyKey=${encodeURIComponent(`auto-verify-smoke:${jobId}:${wallet}`)}`,
    { method: "POST", headers: { ...authHeader } }
  );
  assert(claim.status === "claimed", `Expected claimed session, got ${claim.status}`);

  const submitted = await readJson(
    baseUrl,
    `/jobs/submit?sessionId=${encodeURIComponent(claim.sessionId)}&evidence=${encodeURIComponent(evidence)}`,
    { method: "POST", headers: { ...authHeader } }
  );
  assert(submitted.status === "submitted", `Expected submitted session, got ${submitted.status}`);

  // The whole point of the smoke: do NOT call /verifier/run. Poll until the
  // backend's auto-verifier settles the session on its own.
  console.log("Submitted. Waiting for auto-verify to settle (no manual /verifier/run)...");
  const deadline = Date.now() + timeoutMs;
  let session;
  let settled = false;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    session = await readJson(baseUrl, `/session?sessionId=${encodeURIComponent(claim.sessionId)}`, {
      headers: { ...authHeader }
    });
    console.log(`  session status: ${session.status}`);
    if (session.status === "resolved" || session.status === "rejected") {
      settled = true;
      break;
    }
  }

  assert(settled, `Session ${claim.sessionId} did not auto-settle within ${timeoutMs}ms (last status: ${session?.status ?? "unknown"}). Is AUTO_VERIFY_ENABLED=1 on the backend?`);
  assert(session.status === "resolved", `Expected auto-resolved (approved) session, got ${session.status}`);

  const after = await readJson(baseUrl, "/account", { headers: { ...authHeader } });
  const endingBalance = liquidBalance(after, rewardAsset);
  const delta = endingBalance - startingBalance;
  console.log(`Worker ${rewardAsset} liquid balance after: ${endingBalance} (delta ${delta})`);
  assert(delta > 0, `Expected worker ${rewardAsset} balance to rise after auto-settle, got delta ${delta}`);

  console.log("Auto-verify remote smoke passed");
  console.log(JSON.stringify({
    baseUrl,
    wallet,
    jobId,
    sessionId: claim.sessionId,
    sessionStatus: session.status,
    rewardAsset,
    startingBalance,
    endingBalance,
    rewardDelta: delta,
    authMode,
    signedIn: Boolean(privateKey)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
