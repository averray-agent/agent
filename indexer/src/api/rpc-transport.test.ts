import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";

import {
  createIndexerRpcFetch,
  createIndexerRpcTransport,
  resolveIndexerRpcUrls,
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

test("first URL timeout reaches the second provider and succeeds inside one Ponder probe cycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const calls: Array<{ url: string; at: number }> = [];
  const sleeps: number[] = [];
  const transport = createIndexerRpcTransport(["https://slow.invalid", "https://fast.invalid"], {
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), at: Date.now() });
      if (String(input).includes("slow")) return pendingUntilAbort(init);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x190f1b43" });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  })({ retryCount: 0, timeout: 10_000 }); // Ponder's actual custom-transport arguments.
  const result = transport.request({ method: "eth_chainId" });
  await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(5_000);
  await setImmediate();
  assert.equal(await result, "0x190f1b43");
  assert.deepEqual(calls, [
    { url: "https://slow.invalid/", at: 0 }, { url: "https://fast.invalid/", at: 5_000 },
  ]);
  assert.deepEqual(sleeps, [], "switch hosts before any whole-chain backoff");
  assert.equal(transport.config.type, "fallback");
  assert.equal(transport.config.retryCount, 0);
});

test("three diagnostic attempts wrap the entire fallback chain without multiplying the 50s budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const calls: string[] = [];
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (input, init) => { calls.push(String(input)); return pendingUntilAbort(init); },
  })({ retryCount: 0, timeout: 10_000 });
  const result = assert.rejects(transport.request({ method: "eth_chainId" }));
  await setImmediate();
  for (const ms of [5_000, 5_000, 5_000, 5_000, 5_000, 15_000, 5_000, 5_000]) {
    t.mock.timers.tick(ms);
    await setImmediate();
  }
  await result;
  assert.equal(Date.now(), 50_000);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ["https://first.invalid/", "https://second.invalid/"]).flat());
});

test("diagnostic 404 and 5xx retries happen after all fallback providers answered", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response("unavailable", { status: String(input).includes("first") ? 404 : 503 });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  })({});
  await assert.rejects(transport.request({ method: "eth_chainId" }));
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ["https://first.invalid/", "https://second.invalid/"]).flat());
  assert.deepEqual(sleeps, [5_000, 15_000]);
});

test("runtime fallback switches providers once each without diagnostic retries", async () => {
  for (const secondSucceeds of [true, false]) {
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (input) => {
        calls.push(String(input));
        return secondSucceeds && String(input).includes("second")
          ? Response.json({ jsonrpc: "2.0", id: 1, result: "0x100" })
          : new Response("unavailable", { status: 503 });
      },
      sleep: async () => { throw new Error("runtime request must not retry the chain"); },
    })({});
    const result = transport.request({ method: "eth_blockNumber" });
    if (secondSucceeds) assert.equal(await result, "0x100");
    else await assert.rejects(result);
    assert.deepEqual(calls, ["https://first.invalid/", "https://second.invalid/"]);
  }
});

test("RPC_URL and RPC_BACKUP_URLS share backend ordering while existing aliases remain fallbacks", async () => {
  assert.deepEqual(resolveIndexerRpcUrls(420420419, {
    RPC_URL: " https://primary.invalid/ ", RPC_BACKUP_URLS: " https://backup.invalid/,https://primary.invalid/ ",
    DWELLER_RPC_URL: "https://dweller.invalid/", POLKADOT_RPC_URL: "https://dweller.invalid/",
    PONDER_RPC_URL_420420419: "https://eth-rpc.polkadot.io/",
  }), ["https://primary.invalid/", "https://backup.invalid/", "https://dweller.invalid/", "https://eth-rpc.polkadot.io/"]);
  assert.deepEqual(resolveIndexerRpcUrls(420420419, {
    DWELLER_RPC_URL: "https://services.polkadothub-rpc.com/mainnet/",
    PONDER_RPC_URL_420420419: "https://eth-rpc.polkadot.io/",
  }), ["https://services.polkadothub-rpc.com/mainnet/", "https://eth-rpc.polkadot.io/"]);
  assert.deepEqual(resolveIndexerRpcUrls(420420417, {}), ["https://eth-rpc-testnet.polkadot.io/"]);
  assert.throws(() => resolveIndexerRpcUrls(420420419, {}), /no RPC URL configured/u);
  assert.throws(() => createIndexerRpcTransport([]), /at least one RPC URL/u);
  const config = await readFile(new URL("../../ponder.config.ts", import.meta.url), "utf8");
  assert.match(config, /const rpcUrls = resolveIndexerRpcUrls\(chainId\)/u);
  assert.match(config, /rpc: createIndexerRpcTransport\(rpcUrls\)/u);
});

function pendingUntilAbort(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}
