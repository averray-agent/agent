import assert from "node:assert/strict";
import test, { before } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { assertBaseOnlyX402Surface } from "../../mcp-server/src/payments/x402-discovery.js";
import { VERIFY_BILLING_RULE, VERIFY_BASE_NETWORK, VERIFY_PROFILES_URL, VERIFY_X402_DISCOVERY_URL } from "../../mcp-server/src/core/verify-product-copy.js";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
before(() => execFileSync("npm", ["run", "build:site"], { cwd: root, stdio: "pipe" }));

test("directory listing survives the static build and both shipping checks, and serves valid public metadata", async (t) => {
  assert.match(read("scripts/sync-marketing-site.mjs"), /"verify-listing\.json"/u);
  assert.match(read("scripts/ops/deploy-production.sh"), /"verify-listing\.json \/verify-listing\.json"/u);
  assert.match(read("site/verify/index.html"), /href="\/verify-listing\.json"/u);
  const bytes = read("site/verify-listing.json");
  assert.equal(bytes, read("marketing/dist/verify-listing.json"));
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/verify-listing.json" ? 200 : 404, { "content-type": "application/json" });
    response.end(request.url === "/verify-listing.json" ? bytes : "{}");
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/verify-listing.json`);
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.equal(listing.schemaVersion, "averray.verify-directory-listing.v1");
  assert.deepEqual(listing.resource, { url: "https://api.averray.com/verify/runs", method: "POST", mimeType: "application/json" });
  assert.equal(listing.payment.network, VERIFY_BASE_NETWORK);
  assert.equal(listing.payment.requirementsSource, VERIFY_X402_DISCOVERY_URL);
  assert.equal(listing.inputContract.profiles, VERIFY_PROFILES_URL);
  assert.equal(listing.payment.billingRule, VERIFY_BILLING_RULE);
  assert.equal(listing.payment.settlement, "self_capture");
  assert.equal(listing.payment.captureAfter, "approved_or_rejected_verdict");
  assert.equal(listing.payment.automaticBazaarRegistration, false);
  assertBaseOnlyX402Surface(listing);
  assert.doesNotMatch(bytes, /"(?:amount|amountRaw|payTo|paymentSignature|authorization)"|\d+(?:\.\d+)?\s+USDC/u);
  assert.deepEqual([listing.mcp.quote, listing.mcp.start, listing.mcp.poll], ["quoteVerificationRun", "startVerificationRun", "getVerificationRun"]);
});
