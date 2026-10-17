import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Interface, TypedDataEncoder, Wallet } from "ethers";
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
    t.after(() => { gate.close(); gate.provider.destroy(); gate.captureProvider.destroy(); });
    gate.close(); // Observe only ethers' own activity, with gate retries stopped.
    assert.equal(calls, 3, "exactly chainId, name, separator; no hidden wire retries");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(calls, 3, "no independent one-second network-detection loop");
    assert.equal(consoleLog.mock.callCount(), 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].level, "warn");
    assert.equal(records[0].msg, "verification_payment_gate.domain_unavailable");
    assert.match(records[0].cause.responseStatus, new RegExp(String(status)));
    assert.equal(records[0].cause.code, "SERVER_ERROR");
  });
}

test("Base transport itself times out a hung eth_chainId within eight seconds, independently of the domain admission race", { timeout: 12_000 }, async (t) => {
  const url = await rpcFixture(t, () => {});
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, rpcUrl: url, chainId: 8453, asset: env.X402_PAYMENT_ASSET_ADDRESS },
    captureTokenContract: {}, logger: createLogger({ level: "silent" })
  });
  t.after(() => { gate.close(); gate.provider.destroy(); gate.captureProvider.destroy(); });
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

test("capture signer, checkpoints, receipts and log reconciliation use the second provider with original transport settings", { timeout: 15_000 }, async (t) => {
  const abi = new Interface(["function name() view returns (string)", "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function authorizationState(address,bytes32) view returns (bool)"]);
  const domain = { name: env.X402_PAYMENT_ASSET_EIP712_NAME, version: env.X402_PAYMENT_ASSET_EIP712_VERSION,
    chainId: 8453, verifyingContract: env.X402_PAYMENT_ASSET_ADDRESS };
  const methods = [];
  let logRequests = 0;
  const url = await rpcFixture(t, async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    const messages = Array.isArray(input) ? input : [input];
    for (const message of messages) methods.push(message.method);
    if (messages.some((message) => message.method === "eth_getLogs")) {
      if (++logRequests === 1) { res.writeHead(429, { "retry-after": "0" }); res.end(); return; }
      // Longer than the admission transport's eight seconds. A capture log
      // scan must retain its prior timeout and retry policy, not fail each tick.
      await new Promise((resolve) => setTimeout(resolve, 8_200));
    }
    const answers = messages.map(({ id, method, params }) => {
      let result;
      if (method === "eth_chainId") result = "0x2105";
      else if (method === "eth_getLogs") result = [];
      else if (method === "eth_call") {
        const name = abi.parseTransaction({ data: params[0].data }).name;
        result = abi.encodeFunctionResult(name, [name === "name" ? domain.name
          : name === "DOMAIN_SEPARATOR" ? TypedDataEncoder.hashDomain(domain) : false]);
      } else assert.fail(`unexpected RPC ${method}`);
      return { jsonrpc: "2.0", id, result };
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(input) ? answers : answers[0]));
  });
  const gate = await createConfiguredX402VerificationPaymentGate({ ...env, BASE_RPC_URL: url,
    SIGNER_BACKEND: "local", SIGNER_PRIVATE_KEY: Wallet.createRandom().privateKey, LOG_LEVEL: "silent" });
  assert.ok(gate);
  t.after(() => { gate.close(); gate.provider.destroy(); gate.captureProvider.destroy(); });
  assert.notEqual(gate.captureProvider, gate.provider);
  assert.equal(gate.token.runner, gate.provider);
  assert.equal(gate.captureReadToken.runner, gate.captureProvider);
  assert.equal(gate.captureToken.runner.provider, gate.captureProvider,
    "gas, nonce, broadcast and transaction.wait use the capture signer's provider");
  assert.equal(gate.provider._getConnection().timeout, 8_000);
  assert.equal(gate.captureProvider._getConnection().timeout, 300_000);
  for (const method of ["getBlockNumber", "getBlock", "getTransactionReceipt", "getLogs", "call"]) {
    gate.provider[method] = async () => assert.fail(`capture leaked onto fast provider: ${method}`);
  }
  gate.captureProvider.getBlockNumber = async () => 100;
  gate.captureProvider.getBlock = async () => ({ number: 101, timestamp: 100 });
  gate.captureProvider.getTransactionReceipt = async () => ({ status: 1 });
  assert.deepEqual(await gate.prepareCapture(), { fromBlock: 100 });
  const hash = "0x" + "ab".repeat(32);
  assert.equal((await gate.reconcileCapture({ pendingTransactionHash: hash })).status, "captured");
  const result = await gate.reconcileCapture({ authorization: { authorizedAtBlock: 100,
    authorization: { from: env.X402_PAYMENT_PAY_TO, nonce: "0x" + "11".repeat(32), validBefore: "9999999999" } } });
  assert.equal(result.status, "open");
  assert.equal(logRequests, 2, "capture transport must retry HTTP throttling");
  assert.ok(methods.includes("eth_call"));
  const events = new Interface([
    "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
  ]);
  const proof = { from: env.X402_PAYMENT_PAY_TO, to: env.X402_PAYMENT_PAY_TO,
    nonce: "0x" + "11".repeat(32), validBefore: "9999999999", value: "5000000" };
  const event = (name, args) => ({ ...events.encodeEventLog(events.getEvent(name), args),
    address: env.X402_PAYMENT_ASSET_ADDRESS, transactionHash: hash });
  gate.captureProvider.getLogs = async () => [event("AuthorizationUsed", [proof.from, proof.nonce])];
  gate.captureProvider.getTransactionReceipt = async () => ({ status: 1,
    logs: [event("Transfer", [proof.from, proof.to, proof.value])] });
  assert.equal((await gate.reconcileCapture({ authorization: { authorizedAtBlock: 100, authorization: proof } })).status, "captured",
    "event-matched receipts also stay on the capture provider");
});

test("direct gate construction also separates the default capture read transport", () => {
  const gate = new X402VerificationPaymentGate({ config: { enabled: true, rpcUrl: "http://127.0.0.1:1",
    chainId: 8453, asset: env.X402_PAYMENT_ASSET_ADDRESS }, captureTokenContract: {}, logger: createLogger({ level: "silent" }) });
  try {
    assert.notEqual(gate.captureProvider, gate.provider);
    assert.equal(gate.captureReadToken.runner, gate.captureProvider);
    assert.equal(gate.captureProvider._getConnection().timeout, 300_000);
    assert.equal(gate.provider._getConnection().timeout, 8_000);
  } finally { gate.close(); gate.provider.destroy(); gate.captureProvider.destroy(); }
});
