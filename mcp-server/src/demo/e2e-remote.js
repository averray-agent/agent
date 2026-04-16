import { Wallet } from "ethers";
import { loginTestWallet } from "./auth-helper.js";

const DEFAULT_BASE_URL = "https://api.averray.com";
const DEFAULT_WALLET = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";

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

async function main() {
  const baseUrl = (process.env.REMOTE_E2E_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const privateKey = process.env.REMOTE_E2E_PRIVATE_KEY;
  const legacyWallet = process.env.REMOTE_E2E_WALLET ?? DEFAULT_WALLET;
  const timestamp = Date.now();
  const jobId = `remote-e2e-${timestamp}`;
  const evidence = `complete verified output for ${jobId}`;

  console.log(`Base URL: ${baseUrl}`);

  const health = await readJson(baseUrl, "/health");
  assert(health.status === "ok", `Expected healthy API, got ${health.status}`);
  const authMode = health.auth?.mode ?? "unknown";
  console.log(`Auth mode: ${authMode}`);

  // Determine the caller identity and the Authorization header.
  //
  //   - If REMOTE_E2E_PRIVATE_KEY is set, run the full SIWE login flow and use
  //     the resulting JWT on every protected call (works in strict + permissive).
  //   - Otherwise fall back to the legacy ?wallet= query param (permissive only).
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
          "Set it to an ethers-compatible hex private key for the caller wallet."
      );
    }
    // In permissive mode we can still derive a deterministic checksummed address
    // from REMOTE_E2E_WALLET, but no signing happens.
    try {
      wallet = new Wallet(legacyWallet).address; // eslint-disable-line no-new
    } catch {
      // legacyWallet is already an address, not a private key — use as-is.
    }
    console.log(`Wallet (permissive, unsigned): ${wallet}`);
  }

  console.log(`Job: ${jobId}`);

  // /admin/jobs is intentionally unauthenticated for now (pending RBAC).
  const createdJob = await readJson(baseUrl, "/admin/jobs", {
    method: "POST",
    body: JSON.stringify({
      id: jobId,
      category: "coding",
      tier: "starter",
      rewardAmount: 6,
      verifierMode: "benchmark",
      verifierTerms: ["complete", "verified", "output"],
      verifierMinimumMatches: 2,
      requiresSponsoredGas: true,
      claimTtlSeconds: 3600,
      retryLimit: 1,
      outputSchemaRef: "schema://jobs/remote-e2e-output"
    })
  });

  assert(createdJob.id === jobId, `Expected created job id ${jobId}, got ${createdJob.id}`);

  // Protected routes: append ?wallet= only as a permissive-mode fallback. With
  // a JWT present the middleware ignores the query param and uses the token
  // subject, so the extra param is harmless but keeps this script usable
  // against legacy deployments.
  const walletQs = `wallet=${encodeURIComponent(wallet)}`;

  const claim = await readJson(
    baseUrl,
    `/jobs/claim?${walletQs}&jobId=${encodeURIComponent(jobId)}&idempotencyKey=${encodeURIComponent(`remote-e2e:${jobId}:${wallet}`)}`,
    { method: "POST", headers: { ...authHeader } }
  );
  assert(claim.status === "claimed", `Expected claimed session, got ${claim.status}`);

  const submitted = await readJson(
    baseUrl,
    `/jobs/submit?sessionId=${encodeURIComponent(claim.sessionId)}&evidence=${encodeURIComponent(evidence)}`,
    { method: "POST", headers: { ...authHeader } }
  );
  assert(submitted.status === "submitted", `Expected submitted session, got ${submitted.status}`);

  // /verifier/run is intentionally unauthenticated for now (pending RBAC).
  const verification = await readJson(
    baseUrl,
    `/verifier/run?sessionId=${encodeURIComponent(claim.sessionId)}&evidence=${encodeURIComponent(evidence)}`,
    { method: "POST" }
  );
  assert(verification.outcome === "approved", `Expected approved outcome, got ${verification.outcome}`);

  const session = await readJson(baseUrl, `/session?sessionId=${encodeURIComponent(claim.sessionId)}`, {
    headers: { ...authHeader }
  });
  assert(session.status === "resolved", `Expected resolved session, got ${session.status}`);

  const history = await readJson(
    baseUrl,
    `/sessions?${walletQs}&jobId=${encodeURIComponent(jobId)}&limit=5`,
    { headers: { ...authHeader } }
  );
  assert(Array.isArray(history) && history.some((entry) => entry.sessionId === claim.sessionId), "Expected remote job session in history.");

  console.log("Remote E2E passed");
  console.log(JSON.stringify({
    baseUrl,
    wallet,
    jobId,
    sessionId: claim.sessionId,
    verificationOutcome: verification.outcome,
    verificationReasonCode: verification.reasonCode,
    sessionStatus: session.status,
    authMode,
    signedIn: Boolean(privateKey)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
