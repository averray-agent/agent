import { createPlatformRuntime } from "../services/bootstrap.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is required for the Redis persistence check.");
  }

  const namespace = process.env.REDIS_NAMESPACE ?? `agent-platform-check-${Date.now()}`;
  process.env.REDIS_NAMESPACE = namespace;

  const runtimeA = await createPlatformRuntime();
  const runtimeB = await createPlatformRuntime();

  const firstSession = await runtimeA.platformService.claimJob(
    "0xagent",
    "starter-coding-002",
    "http",
    `redis-check-${Date.now()}`
  );

  await runtimeA.platformService.submitWork(
    firstSession.sessionId,
    "mcp",
    "complete verified output bundle"
  );

  const verification = await runtimeA.verifierService.verifySubmission({
    sessionId: firstSession.sessionId,
    evidence: "complete verified output bundle",
    metadataURI: "ipfs://badge/redis-check"
  });

  const resumedFromSecondRuntime = await runtimeB.platformService.resumeSession(firstSession.sessionId);
  const resultFromSecondRuntime = await runtimeB.verifierService.getResult(firstSession.sessionId);

  assert(resumedFromSecondRuntime.status === "resolved", `Expected resolved session, got ${resumedFromSecondRuntime.status}`);
  assert(resultFromSecondRuntime?.reasonCode === verification.reasonCode, "Stored verification result did not persist across runtimes.");

  console.log(JSON.stringify({
    namespace,
    sessionId: firstSession.sessionId,
    resumedStatus: resumedFromSecondRuntime.status,
    verificationReason: resultFromSecondRuntime?.reasonCode,
    backend: "redis"
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
