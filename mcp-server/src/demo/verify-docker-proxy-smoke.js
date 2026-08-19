import assert from "node:assert/strict";

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

console.log(JSON.stringify({ ok: true, proxy: "reachable", disallowedExec: "refused" }));
