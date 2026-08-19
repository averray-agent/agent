import test from "node:test";
import assert from "node:assert/strict";

import {
  createIndexerRpcFetch,
  INDEXER_RPC_PROBE_RETRY_DELAYS_MS
} from "../rpc-transport.ts";

const rpcRequest = (method: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method })
});

test("indexer RPC diagnostic retries the observed transient 404 before succeeding", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchRpc = createIndexerRpcFetch({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("not found", { status: 404 })
        : Response.json({ jsonrpc: "2.0", id: 1, result: "0x190f1b43" });
    },
    sleep: async (delayMs) => { sleeps.push(delayMs); },
    retryDelaysMs: [5_000, 15_000]
  });

  const response = await fetchRpc("https://eth-rpc.polkadot.io/", rpcRequest("eth_chainId"));

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5_000]);
  assert.deepEqual(INDEXER_RPC_PROBE_RETRY_DELAYS_MS, [5_000, 15_000]);
});

test("indexer RPC diagnostic retries 5xx but remains bounded to three attempts", async () => {
  let calls = 0;
  const fetchRpc = createIndexerRpcFetch({
    fetchImpl: async () => {
      calls += 1;
      return new Response("upstream unavailable", { status: 503 });
    },
    sleep: async () => {},
    retryDelaysMs: [0, 0]
  });

  const response = await fetchRpc("https://eth-rpc.polkadot.io/", rpcRequest("eth_chainId"));

  assert.equal(response.status, 503);
  assert.equal(calls, 3);
});

test("indexer RPC diagnostic retries timeouts but remains fail-closed", async () => {
  let calls = 0;
  const fetchRpc = createIndexerRpcFetch({
    fetchImpl: async (_input, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
    sleep: async () => {},
    retryDelaysMs: [0, 0],
    attemptTimeoutMs: 1
  });

  await assert.rejects(
    () => fetchRpc("https://eth-rpc.polkadot.io/", rpcRequest("eth_chainId"))
  );
  assert.equal(calls, 3);
});

test("non-diagnostic indexer RPC requests do not inherit the boot-probe retry", async () => {
  let calls = 0;
  const fetchRpc = createIndexerRpcFetch({
    fetchImpl: async () => {
      calls += 1;
      return new Response("upstream unavailable", { status: 503 });
    },
    sleep: async () => { throw new Error("runtime request must not retry"); },
    retryDelaysMs: [0, 0]
  });

  const response = await fetchRpc("https://eth-rpc.polkadot.io/", rpcRequest("eth_blockNumber"));

  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});
