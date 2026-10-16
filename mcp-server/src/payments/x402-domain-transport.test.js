import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLogger } from "../core/logger.js";
import { X402VerificationPaymentGate, createConfiguredX402VerificationPaymentGate } from "./x402-verification-payment-gate.js";

const env = { X402_VERIFY_MODE: "enabled", X402_PAYMENT_NETWORK: "eip155:8453",
  X402_PAYMENT_ASSET_ADDRESS: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  X402_PAYMENT_PAY_TO: "0x1111111111111111111111111111111111111111",
  X402_PAYMENT_ASSET_EIP712_NAME: "USD Coin", X402_PAYMENT_ASSET_EIP712_VERSION: "2",
  X402_PUBLIC_ORIGIN: "https://api.averray.com" };

async function rpcFixture(t, handler) {
  const rpc = createServer(handler);
  await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  t.after(async () => { rpc.closeAllConnections(); await new Promise((resolve) => rpc.close(resolve)); });
  return `http://127.0.0.1:${rpc.address().port}`;
}

for (const status of [503, 429]) {
  test(`Base HTTP ${status} makes one wire attempt per domain read and has no independent detection/retry loop`, async (t) => {
    let calls = 0;
    const url = await rpcFixture(t, async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      calls += Array.isArray(payload) ? payload.length : 1;
      res.writeHead(status); res.end("temporarily unavailable");
    });
    const records = [];
    const consoleLog = t.mock.method(console, "log", () => {});
    const gate = await createConfiguredX402VerificationPaymentGate({ ...env, BASE_RPC_URL: url }, {
      captureTokenContract: {}, logger: createLogger({ level: "warn", sink: (_, record) => records.push(record) })
    });
    assert.ok(gate);
    t.after(() => { gate.close(); gate.provider.destroy(); });
    gate.close(); // Observe only ethers' own activity, with gate retries stopped.
    assert.equal(calls, 3, "exactly chainId, name, separator; no hidden wire retries");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(calls, 3, "no independent one-second network-detection loop");
    assert.equal(consoleLog.mock.callCount(), 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].level, "warn");
    assert.equal(records[0].msg, "verification_payment_gate.domain_unavailable");
  });
}

test("Base transport itself times out a hung eth_chainId within eight seconds, independently of the domain admission race", { timeout: 12_000 }, async (t) => {
  const url = await rpcFixture(t, () => {});
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, rpcUrl: url, chainId: 8453, asset: env.X402_PAYMENT_ASSET_ADDRESS },
    captureTokenContract: {}, logger: createLogger({ level: "silent" })
  });
  t.after(() => { gate.close(); gate.provider.destroy(); });
  let deadline;
  const start = performance.now();
  try {
    await assert.rejects(Promise.race([
      gate.provider.send("eth_chainId", []),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("transport did not time out")), 9_500); })
    ]), (error) => error.code === "TIMEOUT");
    assert.ok(performance.now() - start < 9_500);
  } finally { clearTimeout(deadline); }
});
