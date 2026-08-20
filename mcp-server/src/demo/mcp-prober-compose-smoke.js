import assert from "node:assert/strict";

const gateway = "http://mcp-egress-proxy:8080/probe";
const profile = { ref: "mcp-failure-semantics-v1@1", version: 1, limits: { timeoutMs: 30_000 } };
const auth = { scheme: "bearer", credentialRef: "compose-fixture-run-only" };

await waitHealthy("http://mcp-egress-proxy:8080/health");
const good = await probe("verify-compose-good", "mcp-known-good", "known-good-grant");
console.log(JSON.stringify({ fixture: "known-good", status: good.status, reason: good.reason, checks: good.report?.checks }));
assert.equal(good.status, "decidable");
assert.deepEqual(good.report.checks.map(({ name, verdict }) => [name, verdict]), [
  ["auth-boundary", "pass"], ["timeout-recovery", "pass"], ["tool-schema-stability", "pass"],
  ["destructive-action-safety", "pass"], ["error-shape-conformance", "pass"]
]);
const bad = await probe("verify-compose-bad", "mcp-known-bad", "known-bad-grant");
console.log(JSON.stringify({ fixture: "known-bad", status: bad.status, reason: bad.reason, checks: bad.report?.checks }));
assert.equal(bad.status, "decidable");
assert.deepEqual(bad.report.checks.filter(({ verdict }) => verdict === "fail").map(({ name }) => name), ["destructive-action-safety"]);
assert.equal(bad.report.checks.filter(({ verdict }) => verdict === "pass").length, 4);

// Deliberately point the good-host grant at the second host. This must be
// refused by the CONNECT boundary and classified as our platform fault.
const mutation = await probe("verify-compose-egress-mutation", "mcp-known-bad", "known-good-grant");
assert.equal(mutation.status, "platform_fault");
assert.equal(mutation.reason, "runner_fault");
console.log("MCP prober compose smoke passed: known-good, isolated known-bad, and egress mutation deny.");

async function probe(runId, host, egressGrant) {
  const response = await fetch(gateway, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId, profile, target: { endpoint: `http://${host}:8080/mcp`, transport: "streamable_http", auth },
      inputs: {}, credential: "fixture-scoped-token", egressGrant
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitHealthy(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
