import assert from "node:assert/strict";
import test from "node:test";

import { PEOPLE_LITE_FIXTURE_AT, PEOPLE_LITE_FIXTURE_WALLETS } from "../core/people-lite.js";
import { createPeopleLiteReader, peopleLiteReaderFromEnv } from "./people-lite-reader.js";

function json(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}

test("fixture reader returns none, lite, and full for the three wallets at one pin", async () => {
  const reader = createPeopleLiteReader({ source: "fixtures" });
  const body = await reader.readMany(Object.values(PEOPLE_LITE_FIXTURE_WALLETS));
  assert.equal(body.at.blockHash, PEOPLE_LITE_FIXTURE_AT.blockHash);
  assert.equal(body.at.blockNumber, PEOPLE_LITE_FIXTURE_AT.blockNumber);
  assert.deepEqual(body.results.map((read) => read.tier), ["none", "lite", "full"]);
  assert.deepEqual(body.results.map((read) => read.displayName), [null, "cedar.07", "cedar.dot"]);
  for (const read of body.results) {
    assert.equal(read.at.blockHash, body.at.blockHash);
    assert.equal(read.at.blockNumber, body.at.blockNumber);
  }
  const unknown = await reader.read("0x00000000000000000000000000000000000000aa");
  assert.equal(unknown.tier, "none");
  assert.equal(unknown.detail.sdkTag, "NotEnrolled");
  assert.equal(unknown.detail.recognized, false);
  assert.equal(unknown.at.blockHash, PEOPLE_LITE_FIXTURE_AT.blockHash);
});

test("hub reader pins every wallet in a batch to the same finalized block and does not cache it", async () => {
  const blocks = ["0x10", "0x11"];
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === "eth_chainId") {
      return json({ result: "0x190f1b43" });
    }
    if (body.method === "eth_getBlockByNumber") {
      assert.deepEqual(body.params, ["finalized", false]);
      const number = blocks.shift();
      return json({
        result: {
          hash: `0x${number.slice(2).padStart(64, "0")}`,
          number
        }
      });
    }
    if (body.method === "eth_call") {
      const block = body.params[1];
      assert.match(block, /^0x[0-9a-f]{64}$/u);
      const data = body.params[0].data;
      const status = data.includes(PEOPLE_LITE_FIXTURE_WALLETS.lite.slice(2))
        ? 1
        : data.includes(PEOPLE_LITE_FIXTURE_WALLETS.full.slice(2))
          ? 2
          : 0;
      const word = status.toString(16).padStart(64, "0");
      const alias = status === 0 ? "0".repeat(64) : "33".repeat(32);
      return json({ result: `0x${word}${alias}` });
    }
    throw new Error(body.method);
  };
  const reader = createPeopleLiteReader({
    source: "hub",
    rpcUrl: "https://hub.example",
    fetchImpl
  });
  const first = await reader.readMany([
    PEOPLE_LITE_FIXTURE_WALLETS.none,
    PEOPLE_LITE_FIXTURE_WALLETS.lite,
    PEOPLE_LITE_FIXTURE_WALLETS.full
  ]);
  assert.equal(first.at.blockNumber, 16);
  assert.equal(first.at.chain, "polkadot-hub");
  assert.equal(first.at.chainId, 420420419);
  assert.deepEqual(first.results.map((read) => read.tier), ["none", "lite", "full"]);
  assert.deepEqual(first.results.map((read) => read.at.blockHash), [
    first.at.blockHash,
    first.at.blockHash,
    first.at.blockHash
  ]);
  const callBlocks = calls
    .filter((body) => body.method === "eth_call")
    .map((body) => body.params[1]);
  assert.equal(new Set(callBlocks).size, 1);
  assert.equal(callBlocks[0], first.at.blockHash);

  const second = await reader.read(PEOPLE_LITE_FIXTURE_WALLETS.lite);
  assert.equal(second.at.blockNumber, 17);
  assert.notEqual(second.at.blockHash, first.at.blockHash);
  assert.equal(second.tier, "lite");
  assert.equal(second.displayName, null);
  assert.equal(second.detail.sdkTag, "Lite");
});

test("an undecodable precompile result is not reported as none", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "eth_chainId") return json({ result: "0x190f1b43" });
    if (body.method === "eth_getBlockByNumber") {
      return json({ result: { hash: `0x${"44".repeat(32)}`, number: "0x20" } });
    }
    return json({ result: "0x" });
  };
  const reader = createPeopleLiteReader({
    source: "hub",
    rpcUrl: "https://hub.example",
    fetchImpl
  });
  const read = await reader.read(PEOPLE_LITE_FIXTURE_WALLETS.none);
  assert.equal(read.available, false);
  assert.equal(read.tier, null);
  assert.equal(read.at.blockNumber, 32);
});

test("env selects fixtures, hub, or off without calling a websocket RPC", () => {
  assert.equal(peopleLiteReaderFromEnv({ PEOPLE_LITE_SOURCE: "fixtures" }).mode, "fixtures");
  assert.equal(peopleLiteReaderFromEnv({}).mode, "off");
  assert.equal(peopleLiteReaderFromEnv({
    POLKADOT_RPC_URL: "wss://polkadot-asset-hub-rpc.polkadot.io",
    RPC_URL: "https://eth-rpc.polkadot.io"
  }).mode, "hub");
  assert.equal(peopleLiteReaderFromEnv({ PEOPLE_LITE_SOURCE: "off", RPC_URL: "https://eth-rpc.polkadot.io" }).mode, "off");
});
