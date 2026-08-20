import assert from "node:assert/strict";

import { replayStructuredOutputEvidenceFixture } from "./structured-output-evidence-fixture-replay.js";

const dockerHost = String(process.env.DOCKER_HOST ?? "").replace(/^tcp:/u, "http:");
if (!dockerHost.startsWith("http://")) throw new Error("DOCKER_HOST must use tcp:// for the proxy smoke.");

const ping = await fetch(`${dockerHost}/_ping`);
assert.equal(ping.status, 200);
assert.equal((await ping.text()).trim(), "OK");

for (const path of [
  "/containers/arbitrary/exec",
  "/containers/averray-witness-mutation/exec"
]) {
  const response = await fetch(`${dockerHost}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 403, `${path} must be refused by the proxy`);
}

const structuredReplay = await replayStructuredOutputEvidenceFixture();
assert.equal(structuredReplay.fixture.request.target.sources.length, 2);
assert.ok(JSON.parse(structuredReplay.fixture.artifacts.output).citations.length >= 3);
assert.equal(structuredReplay.execution.status, "decidable");
assert.deepEqual(
  structuredReplay.execution.report.checks.map(({ name, verdict }) => [name, verdict]),
  [
    ["output-integrity", "pass"],
    ["schema-valid", "pass"],
    ["schema-conformance", "pass"],
    ["citation-resolution", "pass"],
    ["quote-support", "pass"]
  ]
);

console.log(JSON.stringify({
  ok: true,
  proxy: "reachable",
  disallowedExec: "refused",
  structuredOutputEvidenceFixture: "pass",
  structuredOutputEvidenceChecks: structuredReplay.execution.report.checks.length
}));
