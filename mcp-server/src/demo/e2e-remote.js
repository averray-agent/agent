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
  const wallet = process.env.REMOTE_E2E_WALLET ?? DEFAULT_WALLET;
  const timestamp = Date.now();
  const jobId = `remote-e2e-${timestamp}`;
  const evidence = `complete verified output for ${jobId}`;

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Wallet: ${wallet}`);
  console.log(`Job: ${jobId}`);

  const health = await readJson(baseUrl, "/health");
  assert(health.status === "ok", `Expected healthy API, got ${health.status}`);

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

  const claim = await readJson(
    baseUrl,
    `/jobs/claim?wallet=${encodeURIComponent(wallet)}&jobId=${encodeURIComponent(jobId)}&idempotencyKey=${encodeURIComponent(`remote-e2e:${jobId}:${wallet}`)}`,
    { method: "POST" }
  );
  assert(claim.status === "claimed", `Expected claimed session, got ${claim.status}`);

  const submitted = await readJson(
    baseUrl,
    `/jobs/submit?sessionId=${encodeURIComponent(claim.sessionId)}&evidence=${encodeURIComponent(evidence)}`,
    { method: "POST" }
  );
  assert(submitted.status === "submitted", `Expected submitted session, got ${submitted.status}`);

  const verification = await readJson(
    baseUrl,
    `/verifier/run?sessionId=${encodeURIComponent(claim.sessionId)}&evidence=${encodeURIComponent(evidence)}`,
    { method: "POST" }
  );
  assert(verification.outcome === "approved", `Expected approved outcome, got ${verification.outcome}`);

  const session = await readJson(baseUrl, `/session?sessionId=${encodeURIComponent(claim.sessionId)}`);
  assert(session.status === "resolved", `Expected resolved session, got ${session.status}`);

  const history = await readJson(
    baseUrl,
    `/sessions?wallet=${encodeURIComponent(wallet)}&jobId=${encodeURIComponent(jobId)}&limit=5`
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
    sessionStatus: session.status
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
