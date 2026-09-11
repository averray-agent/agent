import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { HttpRequestError } from "viem";

import {
  createIndexerRpcFetch,
  createIndexerRpcTransport,
  resolveIndexerRpcUrls,
  IncompleteBlockResponseError,
  InconsistentLogsResponseError,
  INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS,
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
    const sleeps: number[] = [];
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (input) => {
        calls.push(String(input));
        return secondSucceeds && String(input).includes("second")
          ? Response.json({ jsonrpc: "2.0", id: 1, result: "0x100" })
          : new Response("unavailable", { status: 503 });
      },
      sleep: async (ms) => { sleeps.push(ms); },
    })({});
    const result = transport.request({ method: "eth_blockNumber" });
    if (secondSucceeds) assert.equal(await result, "0x100");
    else await assert.rejects(result, (error) => {
      assert.ok(error instanceof HttpRequestError, "must preserve the provider failure, not a retry-helper error");
      assert.equal(error.status, 503);
      return true;
    });
    assert.deepEqual(sleeps, [], "runtime fallback must never invoke diagnostic backoff");
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

test("production template explicitly cross-checks Dweller against the public backup", async () => {
  const template = await readFile(new URL("../../../deploy/indexer.mainnet.env.template", import.meta.url), "utf8");
  const env = Object.fromEntries([...template.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gmu)]
    .map((match) => [match[1], match[2]]));
  const expected = ["https://services.polkadothub-rpc.com/mainnet/", "https://eth-rpc.polkadot.io/"];
  assert.equal(env.RPC_BACKUP_URLS, expected[1], "backup must be explicit, not dependent on the PONDER alias");
  assert.deepEqual(resolveIndexerRpcUrls(420420419, env), expected);
  delete env.PONDER_RPC_URL_420420419;
  assert.deepEqual(resolveIndexerRpcUrls(420420419, env), expected, "explicit backup survives removal of the compatibility alias");
});

// 2026-09-10 mainnet incident: services.polkadothub-rpc.com served block
// 20501734 (0x138d4e6) with an empty `transactions` array although the header
// carries gasUsed=0x7191 and a non-zero logsBloom, returned 0 logs for the
// block and null for the receipt of 0xa432e1b3…, while eth-rpc.polkadot.io
// served the full block, 3 logs and the receipt. These fixtures are the raw
// responses captured 2026-09-11T09:47Z (the hole was still open).
const HOLE_BLOCK = "0x138d4e6";
const HOLE_TX = "0xa432e1b35eaf2ee9a21d13edb729e78210a5ec508c264de52d277fa7d3f19030";
async function holeFixture(name: string): Promise<{ result: unknown }> {
  return JSON.parse(await readFile(new URL(`./fixtures/rpc-hole-20501734/${name}.json`, import.meta.url), "utf8"));
}

type RpcBody = { id: number; method: string; params: unknown[] };
function rpcBody(init: RequestInit | undefined): RpcBody {
  return JSON.parse(String(init?.body)) as RpcBody;
}
function rpcResponse(init: RequestInit | undefined, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: rpcBody(init).id, result });
}

test("an incomplete block from one provider falls through to the next provider (2026-09-10 DWELLER hole)", async () => {
  const [dweller, ethRpc] = await Promise.all([holeFixture("dweller-block-full"), holeFixture("eth-rpc-block-full")]);
  const calls: string[] = [];
  const warnings: string[] = [];
  const transport = createIndexerRpcTransport(["https://dweller.invalid", "https://eth-rpc.invalid"], {
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.deepEqual(rpcBody(init).params, [HOLE_BLOCK, true]);
      return rpcResponse(init, String(input).includes("dweller") ? dweller.result : ethRpc.result);
    },
    warn: (message) => { warnings.push(message); },
  })({});

  const block = await transport.request({ method: "eth_getBlockByNumber", params: [HOLE_BLOCK, true] }) as { transactions: Array<{ hash: string; transactionIndex: string }> };

  assert.deepEqual(calls, ["https://dweller.invalid/", "https://eth-rpc.invalid/"]);
  assert.equal(block.transactions.length, 1);
  assert.equal(block.transactions[0]?.hash, HOLE_TX);
  assert.equal(block.transactions[0]?.transactionIndex, "0x3");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /dweller\.invalid/u);
  assert.match(warnings[0]!, /20501734/u);
});

test("an incomplete block from every provider fails loudly naming the provider and block", async () => {
  const dweller = await holeFixture("dweller-block-full");
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (_input, init) => rpcResponse(init, dweller.result),
    warn: () => {},
  })({});

  await assert.rejects(
    transport.request({ method: "eth_getBlockByHash", params: ["0x2efe1d962e2ad4d4030e4ba2f34d5c202a1450fd0c4b5799b4a71c465b4d84cc", true] }),
    (error: unknown) => {
      assert.ok(error instanceof IncompleteBlockResponseError, `expected IncompleteBlockResponseError, got ${String(error)}`);
      assert.match(error.message, /second\.invalid/u);
      assert.match(error.message, /20501734/u);
      assert.match(error.message, /gasUsed=0x7191/u);
      return true;
    }
  );
});

test("a genuinely empty block passes the completeness guard untouched", async () => {
  const dweller = await holeFixture("dweller-block-full");
  const emptyBlock = {
    ...(dweller.result as Record<string, unknown>),
    number: "0x138d4e7",
    gasUsed: "0x0",
    logsBloom: `0x${"0".repeat(512)}`,
    transactions: [],
  };
  const calls: string[] = [];
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (input, init) => { calls.push(String(input)); return rpcResponse(init, emptyBlock); },
    warn: () => { throw new Error("an empty block must not warn"); },
  })({});

  const block = await transport.request({ method: "eth_getBlockByNumber", params: ["0x138d4e7", true] });

  assert.deepEqual(block, emptyBlock);
  assert.deepEqual(calls, ["https://first.invalid/"]);
});

test("eth_getLogs is cross-checked across providers: the superset answers and the hole is named", async () => {
  const [dwellerLogs, ethRpcLogs] = await Promise.all([holeFixture("dweller-logs"), holeFixture("eth-rpc-logs")]);
  const calls: string[] = [];
  const warnings: string[] = [];
  const transport = createIndexerRpcTransport(["https://dweller.invalid", "https://eth-rpc.invalid"], {
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      return rpcResponse(init, String(input).includes("dweller") ? dwellerLogs.result : ethRpcLogs.result);
    },
    warn: (message) => { warnings.push(message); },
  })({});

  const logs = await transport.request({ method: "eth_getLogs", params: [{ fromBlock: HOLE_BLOCK, toBlock: HOLE_BLOCK }] });

  assert.deepEqual(logs, ethRpcLogs.result, "the provider holding the strict superset must answer");
  assert.deepEqual(calls.sort(), ["https://dweller.invalid/", "https://eth-rpc.invalid/"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /https:\/\/dweller\.invalid omitted 3 log\(s\) present at https:\/\/eth-rpc\.invalid /u);
  assert.match(warnings[0]!, /20501734#8/u);
  assert.match(warnings[0]!, /20501734#10/u);
  assert.match(warnings[0]!, /20501734#9/u);
});

test("eth_getLogs answers from the primary without warning when every provider agrees", async () => {
  const ethRpcLogs = await holeFixture("eth-rpc-logs");
  const calls: string[] = [];
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      // Same log set, different provider ordering: order must not count as a conflict.
      const logs = ethRpcLogs.result as unknown[];
      return rpcResponse(init, String(input).includes("second") ? [...logs].reverse() : logs);
    },
    warn: () => { throw new Error("agreeing providers must not warn"); },
  })({});

  const logs = await transport.request({ method: "eth_getLogs", params: [{ fromBlock: HOLE_BLOCK, toBlock: HOLE_BLOCK }] });

  assert.deepEqual(logs, ethRpcLogs.result, "the primary's ordering is preserved");
  assert.deepEqual(calls.sort(), ["https://first.invalid/", "https://second.invalid/"]);
});

test("eth_getLogs refuses conflicting provider answers instead of guessing", async () => {
  const ethRpcLogs = await holeFixture("eth-rpc-logs");
  const [first, second, third] = ethRpcLogs.result as Array<Record<string, unknown>>;
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async (input, init) => rpcResponse(init, String(input).includes("first") ? [first, second] : [second, third]),
    warn: () => {},
  })({});

  await assert.rejects(
    transport.request({ method: "eth_getLogs", params: [{ fromBlock: HOLE_BLOCK, toBlock: HOLE_BLOCK }] }),
    (error: unknown) => {
      assert.ok(error instanceof InconsistentLogsResponseError, `expected InconsistentLogsResponseError, got ${String(error)}`);
      assert.match(error.message, /first\.invalid/u);
      assert.match(error.message, /second\.invalid/u);
      return true;
    }
  );
});

test("eth_getLogs degrades to the answering provider when the other one fails, and fails when all do", async () => {
  const ethRpcLogs = await holeFixture("eth-rpc-logs");
  for (const secondSucceeds of [true, false]) {
    const warnings: string[] = [];
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (input, init) => (secondSucceeds && String(input).includes("second"))
        ? rpcResponse(init, ethRpcLogs.result)
        : new Response("unavailable", { status: 503 }),
      warn: (message) => { warnings.push(message); },
    })({});
    const result = transport.request({ method: "eth_getLogs", params: [{ fromBlock: HOLE_BLOCK, toBlock: HOLE_BLOCK }] });
    if (secondSucceeds) {
      assert.deepEqual(await result, ethRpcLogs.result);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /cross-check degraded/u);
      assert.match(warnings[0]!, /first\.invalid/u);
    } else {
      await assert.rejects(result, (error) => {
        assert.ok(error instanceof HttpRequestError, "must preserve the provider failure");
        assert.equal(error.status, 503);
        return true;
      });
    }
  }
});

test("eth_getLogs waits only a bounded grace for a slow provider once another has answered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const ethRpcLogs = await holeFixture("eth-rpc-logs");
  const warnings: string[] = [];
  const aborted: string[] = [];
  const transport = createIndexerRpcTransport(["https://slow.invalid", "https://fast.invalid"], {
    fetchImpl: async (input, init) => {
      if (String(input).includes("slow")) {
        init?.signal?.addEventListener("abort", () => aborted.push(String(input)), { once: true });
        return pendingUntilAbort(init);
      }
      return rpcResponse(init, ethRpcLogs.result);
    },
    warn: (message) => { warnings.push(message); },
  })({ retryCount: 0, timeout: 10_000 });

  const result = transport.request({ method: "eth_getLogs", params: [{ fromBlock: HOLE_BLOCK, toBlock: HOLE_BLOCK }] });
  await setImmediate();
  assert.equal(warnings.length, 0, "no answer is declared until the grace elapses");
  t.mock.timers.tick(INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS);
  await setImmediate();
  assert.deepEqual(await result, ethRpcLogs.result);
  assert.equal(Date.now(), INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS);
  assert.deepEqual(aborted, ["https://slow.invalid/"], "the laggard request is abandoned, not left in flight");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /cross-check degraded/u);
  assert.match(warnings[0]!, /slow\.invalid/u);
});

test("a single-provider transport neither cross-checks nor guards differently", async () => {
  const ethRpcLogs = await holeFixture("eth-rpc-logs");
  const calls: string[] = [];
  const transport = createIndexerRpcTransport(["https://only.invalid"], {
    fetchImpl: async (input, init) => { calls.push(String(input)); return rpcResponse(init, ethRpcLogs.result); },
    warn: () => { throw new Error("nothing to reconcile with one provider"); },
  })({});

  assert.deepEqual(await transport.request({ method: "eth_getLogs", params: [{ fromBlock: HOLE_BLOCK, toBlock: HOLE_BLOCK }] }), ethRpcLogs.result);
  assert.deepEqual(calls, ["https://only.invalid/"]);
});

function pendingUntilAbort(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}
