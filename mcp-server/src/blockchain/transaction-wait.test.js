import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { waitForTransaction } from "./transaction-wait.js";
import { BlockchainGateway } from "./gateway.js";
import { MemoryStateStore } from "../core/state-store.js";

const HASH = `0x${"ab".repeat(32)}`;
const FROM = `0x${"cd".repeat(20)}`;
const receipt = { hash: HASH, status: 1, blockNumber: 20832907, logs: [] };
const never = () => new Promise(() => {});
function runner(host, read = async () => null) {
  return Object.assign(new EventEmitter(), {
    _getConnection: () => ({ url: `https://secret:password@${host}/key?token=secret` }),
    getTransactionReceipt: read,
    getTransactionCount: async () => 2780
  });
}

test("all 34 gateway receipt waits use the bounded helper; no bare wait remains", () => {
  const source = readFileSync(new URL("./gateway.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.wait\s*\(/u);
  assert.equal([...source.matchAll(/await this\.waitForTransaction\(/gu)].length, 34);
});

test("every gateway wait stage emits structured immediate receipt, block and completion timing", async () => {
  const source = readFileSync(new URL("./gateway.js", import.meta.url), "utf8");
  const stages = [...source.matchAll(/await this\.waitForTransaction\(\w+, "([^"]+)"/gu)].map((match) => match[1]);
  for (const stage of stages) {
    const logs = [];
    const provider = runner("primary.test");
    const tx = { hash: HASH, nonce: 2779, from: FROM, provider, async wait(confirms, timeoutMs) {
      assert.equal(confirms, 1);
      assert.ok(timeoutMs > 0 && timeoutMs <= 60_000);
      provider.emit("block", 20832907);
      return receipt;
    } };
    await waitForTransaction(tx, { stage, jobId: "canary", runners: [provider], logger: { info: (record) => logs.push(record) } });
    for (const event of ["tx_wait_started", "tx_wait_probe", "tx_wait_block", "tx_wait_completed"]) {
      const log = logs.find((record) => record.event === event);
      assert.ok(log, `${stage}: ${event}`);
      assert.equal(log.stage, stage);
      assert.equal(log.txHash, HASH);
      assert.equal(log.nonce, 2779);
      assert.equal(log.jobId, "canary");
      assert.equal(log.runner, "https://primary.test");
      assert.equal(typeof log.ms, "number");
    }
    assert.equal(logs.find((record) => record.event === "tx_wait_probe").receipt, "null");
    assert.equal(logs.at(-1).outcome, "confirmed");
    assert.equal(logs.at(-1).blockEvents, 1);
    assert.equal(provider.listenerCount("block"), 0);
    assert.doesNotMatch(JSON.stringify(logs), /password|token=|\/key/u);
  }
});

test("mined waiver recovers by direct reread across every runner with signer latest nonce, never rebroadcasting", async () => {
  const calls = [];
  const logs = [];
  const providers = ["primary.test", "backup.test"].map((host, index) => {
    let count = 0;
    const provider = runner(host, async (hash) => {
      calls.push([host, "receipt", hash]);
      return ++count > 1 && index === 1 ? receipt : null;
    });
    provider.getTransactionCount = async (from, block) => { calls.push([host, "nonce", from, block]); return 2780; };
    provider.broadcastTransaction = () => assert.fail("receipt recovery must never broadcast");
    return provider;
  });
  const result = await waitForTransaction({ hash: HASH, nonce: 2779, from: FROM, provider: providers[0], wait: never }, {
    stage: "ensureOnboardingWaiverEligibility", timeoutMs: 15, runners: providers, logger: { info: (record) => logs.push(record) }
  });
  assert.equal(result, receipt);
  for (const host of ["primary.test", "backup.test"]) {
    assert.equal(calls.filter((call) => call[0] === host && call[1] === "receipt").length, 2);
    assert.ok(calls.some((call) => call[0] === host && call[1] === "nonce" && call[2] === FROM && call[3] === "latest"));
  }
  assert.equal(logs.find((log) => log.event === "tx_wait_recovered_by_reread").runner, "https://backup.test");
  assert.equal(logs.at(-1).blockEvents, 0);
  assert.ok(logs.at(-1).silenceMs >= 0);
});

test("wait deadline returns brokered_tx_timeout with hash and nonce and persists the job journal", async () => {
  const logs = [];
  const gateway = new BlockchainGateway({ enabled: false, brokeredTxTimeoutMs: 15 }, { logger: { info: (record) => logs.push(record) } });
  gateway.transactionStore = new MemoryStateStore();
  const provider = runner("primary.test");
  gateway.writeBroadcaster = { receiptRunners: [provider] };
  await assert.rejects(gateway.waitForTransaction({ hash: HASH, nonce: 2779, from: FROM, provider, wait: never }, "claimJob", "canary"), (error) => {
    assert.equal(error.code, "brokered_tx_timeout");
    assert.equal(error.statusCode, 502);
    assert.deepEqual(error.details, { stage: "claimJob", jobId: "canary", txHash: HASH, nonce: 2779 });
    return true;
  });
  const journal = await gateway.transactionStore.getServiceState(`brokered-job:${gateway.toJobId("canary")}:claimJob`);
  assert.equal(journal.txHash, HASH);
  assert.equal(journal.nonce, 2779);
  assert.equal(journal.status, "timeout");
  assert.equal(logs.at(-1).outcome, "timeout");
  assert.equal(logs.at(-1).blockEvents, 0);
  assert.ok(logs.at(-1).ms >= 10);
  assert.equal(provider.listenerCount("block"), 0);
});

test("recovered status-zero receipt remains a revert, not a successful settlement", async () => {
  let reads = 0;
  const provider = runner("backup.test", async () => ++reads === 1 ? null : { ...receipt, status: 0 });
  await assert.rejects(waitForTransaction({ hash: HASH, nonce: 2779, from: FROM, provider, wait: never }, {
    stage: "resolveSinglePayout", runners: [provider], timeoutMs: 15
  }), { code: "blockchain_revert" });
});

test("non-timeout wait errors preserve their identity and do not trigger recovery", async () => {
  const error = Object.assign(new Error("replacement"), { code: "TRANSACTION_REPLACED" });
  let reads = 0;
  const provider = runner("primary.test", async () => { reads++; return null; });
  await assert.rejects(waitForTransaction({ hash: HASH, provider, wait: async () => { throw error; } }, { stage: "claimJob", runners: [provider] }), (actual) => actual === error);
  assert.equal(reads, 1);
});
