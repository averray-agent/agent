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
  InconsistentBlockResponseError,
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
  assert.deepEqual(calls, ["https://first.invalid/", "https://second.invalid/"]);
});

// Raw captures from the zero-gas, non-zero-bloom incident on 2026-09-12.
const ZERO_GAS_HOLE_BLOCK = "0x139b3f8";
const ZERO_GAS_HOLE_HASH = "0xbe401358142dd085fd67be24e1fb33494875f2a042239c72f8ce48e94ddff259";
const ZERO_GAS_HOLE_TX = "0x43ea28651af458ac9150cf6c04bae4820b59ef93a1a04432464abb23c1df56d8";
type CapturedBlock = {
  number: string; hash: string; gasUsed: string; logsBloom: string;
  transactions: Array<{ hash: string; transactionIndex: string; blockHash: string; blockNumber: string }>;
};
async function zeroGasFixture(name: string): Promise<{ result: unknown }> {
  return JSON.parse(await readFile(new URL(`./fixtures/rpc-hole-20558840/${name}.json`, import.meta.url), "utf8"));
}
const blockMethods = ["eth_getBlockByNumber", "eth_getBlockByHash"] as const;
function blockParams(method: typeof blockMethods[number], fullTx = true) {
  return [method === "eth_getBlockByNumber" ? ZERO_GAS_HOLE_BLOCK : ZERO_GAS_HOLE_HASH, fullTx] as const;
}

test("real block 20558840: full reads by number and hash select the provider whose transactions match the logs", async () => {
  for (const method of blockMethods) for (const reverse of [false, true]) {
    const fixture = method === "eth_getBlockByNumber" ? "block-full" : "block-by-hash";
    const [dweller, ethRpc, dwellerLogs, ethRpcLogs] = await Promise.all([
      zeroGasFixture(`dweller-${fixture}`), zeroGasFixture(`eth-rpc-${fixture}`),
      zeroGasFixture("dweller-logs"), zeroGasFixture("eth-rpc-logs")
    ]);
    const urls = ["https://dweller.invalid", "https://eth-rpc.invalid"];
    if (reverse) urls.reverse();
    const warnings: string[] = [];
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(urls, {
      fetchImpl: async (input, init) => {
        const body = rpcBody(init);
        calls.push(`${body.method}:${input}`);
        const isDweller = String(input).includes("dweller");
        if (body.method === "eth_getLogs") return rpcResponse(init, isDweller ? dwellerLogs.result : ethRpcLogs.result);
        assert.equal(body.method, method);
        assert.deepEqual(body.params, blockParams(method));
        return rpcResponse(init, isDweller ? dweller.result : ethRpc.result);
      },
      warn: (message) => { warnings.push(message); }
    })({});
    const block = await transport.request({ method, params: blockParams(method) }) as CapturedBlock;
    const logs = await transport.request({ method: "eth_getLogs", params: [{ fromBlock: ZERO_GAS_HOLE_BLOCK, toBlock: ZERO_GAS_HOLE_BLOCK }] }) as Array<{ transactionHash: string; transactionIndex: string }>;
    assert.deepEqual(block, ethRpc.result);
    assert.equal(block.gasUsed, "0x0");
    assert.notEqual(BigInt(block.logsBloom), 0n);
    assert.equal(block.transactions.length, 1);
    assert.equal(block.transactions[0]?.hash, ZERO_GAS_HOLE_TX);
    assert.equal(block.transactions[0]?.transactionIndex, "0x3", "do not replace the chain index with array offset zero");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.transactionHash, block.transactions[0]?.hash);
    assert.equal(logs[0]?.transactionIndex, block.transactions[0]?.transactionIndex);
    assert.equal(calls.filter((call) => call.startsWith(`${method}:`)).length, 2);
    assert.ok(warnings.some((message) => message.includes("dweller.invalid") && message.includes("20558840")));
    assert.ok(warnings.some((message) => message.includes("omitted 1 log(s)")));
  }
});

test("zero gas cannot hide an empty-transaction non-zero-bloom hole even with only one provider", async () => {
  const dweller = await zeroGasFixture("dweller-block-full");
  for (const method of blockMethods) {
    const warnings: string[] = [];
    const transport = createIndexerRpcTransport(["https://dweller.invalid"], {
      fetchImpl: async (_input, init) => rpcResponse(init, dweller.result),
      warn: (message) => { warnings.push(message); }
    })({});
    await assert.rejects(transport.request({ method, params: blockParams(method) }), (error) => {
      assert.ok(error instanceof IncompleteBlockResponseError);
      assert.match(error.message, /20558840.*gasUsed=0x0/u);
      return true;
    });
    assert.equal(warnings.length, 1);
  }
});

test("zero-bloom multisig revive.call-shaped empty EVM blocks remain accepted regardless of gasUsed", async () => {
  const { result } = await zeroGasFixture("dweller-block-full");
  for (const method of blockMethods) for (const gasUsed of ["0x0", "0x7191"]) {
    // Synthetic zero-bloom variant of the captured header, not a new chain capture.
    const empty = { ...(result as CapturedBlock), gasUsed, logsBloom: `0x${"0".repeat(512)}` };
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (_input, init) => rpcResponse(init, empty),
      warn: (message) => assert.fail(message)
    })({});
    assert.deepEqual(await transport.request({ method, params: blockParams(method) }), empty);
  }
});

test("full block cross-check chooses a non-empty transaction superset in either provider order and warns omissions", async () => {
  const base = (await zeroGasFixture("eth-rpc-block-full")).result as CapturedBlock;
  const extra = { ...base.transactions[0]!, hash: `0x${"b".repeat(64)}`, transactionIndex: "0x5" };
  const full = { ...base, transactions: [...base.transactions, extra] }; // Synthetic superset.
  for (const method of blockMethods) for (const reverse of [false, true]) {
    const urls = ["https://subset.invalid", "https://superset.invalid"];
    if (reverse) urls.reverse();
    const warnings: string[] = [];
    const transport = createIndexerRpcTransport(urls, {
      fetchImpl: async (input, init) => rpcResponse(init, String(input).includes("subset") ? base : full),
      warn: (message) => { warnings.push(message); }
    })({});
    assert.deepEqual(await transport.request({ method, params: blockParams(method) }), full);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /subset\.invalid omitted 1 transaction\(s\).*superset\.invalid/u);
    assert.ok(warnings[0]!.includes(extra.hash));
    assert.ok(warnings[0]!.includes("20558840"));
  }
});

test("equal full-block hash sets keep primary ordering and original sparse indices without warnings", async () => {
  const base = (await zeroGasFixture("eth-rpc-block-full")).result as CapturedBlock;
  const full = { ...base, transactions: [...base.transactions, { ...base.transactions[0]!, hash: `0x${"b".repeat(64)}`, transactionIndex: "0x5" }] };
  for (const method of blockMethods) {
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        return rpcResponse(init, String(input).includes("first") ? full : { ...full, transactions: [...full.transactions].reverse() });
      }, warn: (message) => assert.fail(message)
    })({});
    assert.deepEqual(await transport.request({ method, params: blockParams(method) }), full);
    assert.equal(calls.length, 2);
  }
});

test("full block cross-check refuses incomparable hash sets, different blocks, and conflicting transaction indices", async () => {
  const base = (await zeroGasFixture("eth-rpc-block-full")).result as CapturedBlock;
  const tx = base.transactions[0]!;
  const first = { ...base, transactions: [tx, { ...tx, hash: `0x${"b".repeat(64)}`, transactionIndex: "0x5" }] };
  const hash = `0x${"d".repeat(64)}`;
  const conflicts = [
    { ...base, transactions: [tx, { ...tx, hash: `0x${"c".repeat(64)}`, transactionIndex: "0x6" }] },
    { ...first, hash, transactions: first.transactions.map((tx) => ({ ...tx, blockHash: hash })) },
    { ...first, number: "0x139b3f9", transactions: first.transactions.map((tx) => ({ ...tx, blockNumber: "0x139b3f9" })) },
    { ...base, transactions: [{ ...tx, transactionIndex: "0x4" }] }
  ];
  for (const method of blockMethods) for (const second of conflicts) {
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (input, init) => rpcResponse(init, String(input).includes("first") ? first : second),
      warn: (message) => assert.fail(message)
    })({});
    await assert.rejects(transport.request({ method, params: blockParams(method) }), (error) => {
      assert.ok(error instanceof InconsistentBlockResponseError, String(error));
      assert.ok(error.message.includes(method));
      assert.match(error.message, /first\.invalid/u);
      assert.match(error.message, /second\.invalid/u);
      return true;
    });
  }
});

test("non-null hash-only block requests retain ordinary fallback rather than full-transaction cross-checks", async () => {
  const full = (await zeroGasFixture("eth-rpc-block-full")).result as CapturedBlock;
  const hashes = { ...full, transactions: full.transactions.map((tx) => tx.hash) };
  for (const method of blockMethods) {
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
      fetchImpl: async (input, init) => { calls.push(String(input)); return rpcResponse(init, hashes); },
      warn: (message) => assert.fail(message)
    })({});
    assert.deepEqual(await transport.request({ method, params: blockParams(method, false) }), hashes);
    assert.deepEqual(calls, ["https://first.invalid/"]);
  }
});

const NULL_HOLE_NUMBER = "0x139e0ad";
const NULL_HOLE_HASH = "0x708e5e567d9df22a421a02ccd7dd9e7d6345f6848126fdd409facf2138ba8a86";
async function nullHoleFixture(provider: string): Promise<{ result: unknown }> {
  return JSON.parse(await readFile(new URL(`./fixtures/rpc-hole-20570285/${provider}-block-by-hash.json`, import.meta.url), "utf8"));
}
function nullHoleParams(method: typeof blockMethods[number], fullTx: boolean) {
  return [method === "eth_getBlockByNumber" ? NULL_HOLE_NUMBER : NULL_HOLE_HASH, fullTx] as const;
}

test("real block 20570285: Ponder's hash-only parent walk falls through DWELLER null and names the hole", async () => {
  const [dweller, ethRpc] = await Promise.all([nullHoleFixture("dweller"), nullHoleFixture("eth-rpc")]);
  assert.equal(dweller.result, null);
  assert.equal((ethRpc.result as CapturedBlock).number, NULL_HOLE_NUMBER);
  assert.equal((ethRpc.result as CapturedBlock).hash, NULL_HOLE_HASH);
  assert.deepEqual((ethRpc.result as CapturedBlock).transactions, []);
  const calls: string[] = [];
  const warnings: string[] = [];
  const transport = createIndexerRpcTransport(["https://dweller.invalid", "https://eth-rpc.invalid"], {
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.equal(rpcBody(init).method, "eth_getBlockByHash");
      assert.deepEqual(rpcBody(init).params, [NULL_HOLE_HASH, false]);
      return rpcResponse(init, String(input).includes("dweller") ? dweller.result : ethRpc.result);
    },
    warn: (message) => { warnings.push(message); }
  })({});
  assert.deepEqual(await transport.request({ method: "eth_getBlockByHash", params: [NULL_HOLE_HASH, false] }), ethRpc.result);
  assert.deepEqual(calls, ["https://dweller.invalid/", "https://eth-rpc.invalid/"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /dweller\.invalid.*returned null.*eth-rpc\.invalid/u);
  assert.ok(warnings[0]!.includes(NULL_HOLE_HASH), "the warning identifies the missing parent");
});

test("concrete block nulls consult every remaining provider until one has the block, in both transaction modes", async () => {
  const { result: block } = await nullHoleFixture("eth-rpc");
  // Synthetic null-by-number and fullTx variants of the captured empty block.
  for (const method of blockMethods) for (const fullTx of [false, true]) {
    const calls: string[] = [];
    const warnings: string[] = [];
    const urls = ["https://missing-first.invalid", "https://missing-second.invalid", "https://good.invalid"];
    const transport = createIndexerRpcTransport(urls, {
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        assert.deepEqual(rpcBody(init).params, nullHoleParams(method, fullTx));
        return rpcResponse(init, String(input).includes("good") ? block : null);
      },
      warn: (message) => { warnings.push(message); }
    })({});
    assert.deepEqual(await transport.request({ method, params: nullHoleParams(method, fullTx) }), block);
    assert.deepEqual(calls, urls.map((url) => `${url}/`));
    assert.equal(warnings.length, 2);
    for (const provider of ["missing-first", "missing-second"]) {
      assert.ok(warnings.some((message) => message.includes(provider) && message.includes("returned null") && message.includes("good.invalid")));
    }
  }
});

test("concrete blocks return null only after every configured provider returns null", async () => {
  for (const method of blockMethods) for (const fullTx of [false, true]) for (const count of [1, 2, 3]) {
    const urls = Array.from({ length: count }, (_, index) => `https://provider-${index}.invalid`);
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(urls, {
      fetchImpl: async (input, init) => { calls.push(String(input)); return rpcResponse(init, null); },
      warn: (message) => assert.fail(message)
    })({});
    assert.equal(await transport.request({ method, params: nullHoleParams(method, fullTx) }), null);
    assert.deepEqual(calls, urls.map((url) => `${url}/`));
  }
});

test("null plus a provider error is not agreement that a concrete block is absent", async () => {
  for (const method of blockMethods) for (const fullTx of [false, true]) for (const reverse of [false, true]) {
    const urls = ["https://missing.invalid", "https://failed.invalid"];
    if (reverse) urls.reverse();
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(urls, {
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        return String(input).includes("missing") ? rpcResponse(init, null) : new Response("unavailable", { status: 503 });
      },
      warn: () => {}
    })({});
    await assert.rejects(transport.request({ method, params: nullHoleParams(method, fullTx) }),
      (error) => error instanceof HttpRequestError && error.status === 503);
    assert.deepEqual(calls, urls.map((url) => `${url}/`));
  }
});

test("null and failed providers do not prevent a later provider from returning a concrete block", async () => {
  const { result: block } = await nullHoleFixture("eth-rpc");
  for (const method of blockMethods) for (const fullTx of [false, true]) {
    const warnings: string[] = [];
    const transport = createIndexerRpcTransport(["https://missing.invalid", "https://failed.invalid", "https://good.invalid"], {
      fetchImpl: async (input, init) => String(input).includes("failed")
        ? new Response("unavailable", { status: 503 })
        : rpcResponse(init, String(input).includes("missing") ? null : block),
      warn: (message) => { warnings.push(message); }
    })({});
    assert.deepEqual(await transport.request({ method, params: nullHoleParams(method, fullTx) }), block);
    assert.ok(warnings.some((message) => message.includes("missing.invalid") && message.includes("returned null") && message.includes("good.invalid")));
  }
});

test("tag-based block requests retain their existing null behavior in both transaction modes", async () => {
  for (const tag of ["latest", "pending", "earliest", "safe", "finalized"]) for (const fullTx of [false, true]) {
    const calls: string[] = [];
    const transport = createIndexerRpcTransport(["https://missing.invalid", "https://failed.invalid"], {
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        assert.deepEqual(rpcBody(init).params, [tag, fullTx]);
        return String(input).includes("missing") ? rpcResponse(init, null) : new Response("unavailable", { status: 503 });
      },
      warn: () => {}
    })({});
    assert.equal(await transport.request({ method: "eth_getBlockByNumber", params: [tag, fullTx] }), null);
    assert.deepEqual(calls, fullTx
      ? ["https://missing.invalid/", "https://failed.invalid/"]
      : ["https://missing.invalid/"]);
  }
});

test("a concrete full-block null cannot become absence when the other provider outlasts the grace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const aborted: string[] = [];
  const transport = createIndexerRpcTransport(["https://missing.invalid", "https://slow.invalid"], {
    fetchImpl: async (input, init) => {
      if (String(input).includes("missing")) return rpcResponse(init, null);
      init?.signal?.addEventListener("abort", () => aborted.push(String(input)), { once: true });
      return pendingUntilAbort(init);
    },
    warn: () => {}
  })({});
  const rejected = assert.rejects(
    transport.request({ method: "eth_getBlockByHash", params: [NULL_HOLE_HASH, true] }),
    /cross-check grace/u
  );
  await setImmediate();
  t.mock.timers.tick(INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS);
  await setImmediate();
  await rejected;
  assert.deepEqual(aborted, ["https://slow.invalid/"]);
});

test("full block cross-check distinguishes a missing block from a known empty block", async () => {
  const captured = (await zeroGasFixture("dweller-block-full")).result as CapturedBlock;
  const empty = { ...captured, logsBloom: `0x${"0".repeat(512)}` };
  for (const method of blockMethods) for (const second of [null, empty]) {
    const warnings: string[] = [];
    const transport = createIndexerRpcTransport(["https://missing.invalid", "https://second.invalid"], {
      fetchImpl: async (input, init) => rpcResponse(init, String(input).includes("missing") ? null : second),
      warn: (message) => { warnings.push(message); }
    })({});
    assert.deepEqual(await transport.request({ method, params: blockParams(method) }), second);
    assert.equal(warnings.length, second === null ? 0 : 1);
    if (second !== null) assert.match(warnings[0]!, /missing\.invalid returned null/u);
  }
});

test("full block cross-check rejects malformed providers, degrades visibly on failure, and preserves all-provider errors", async () => {
  const base = (await zeroGasFixture("eth-rpc-block-full")).result as CapturedBlock;
  for (const method of blockMethods) for (const broken of [
    undefined, {}, { ...base, transactions: [ZERO_GAS_HOLE_TX] },
    { ...base, transactions: [base.transactions[0], base.transactions[0]] }
  ]) {
    const warnings: string[] = [];
    const transport = createIndexerRpcTransport(["https://broken.invalid", "https://good.invalid"], {
      fetchImpl: async (input, init) => String(input).includes("good") ? rpcResponse(init, base)
        : broken === undefined ? new Response("unavailable", { status: 503 }) : rpcResponse(init, broken),
      warn: (message) => { warnings.push(message); }
    })({});
    assert.deepEqual(await transport.request({ method, params: blockParams(method) }), base);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cross-check degraded.*broken\.invalid/u);
  }
  const transport = createIndexerRpcTransport(["https://first.invalid", "https://second.invalid"], {
    fetchImpl: async () => new Response("unavailable", { status: 503 }), warn: () => {}
  })({});
  await assert.rejects(transport.request({ method: "eth_getBlockByNumber", params: blockParams("eth_getBlockByNumber") }),
    (error) => error instanceof HttpRequestError && error.status === 503);
});

for (const method of blockMethods) test(`${method} fullTx bounds the slow provider grace and aborts its request`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { result: block } = await zeroGasFixture("eth-rpc-block-full");
  const warnings: string[] = [];
  const aborted: string[] = [];
  const transport = createIndexerRpcTransport(["https://slow.invalid", "https://fast.invalid"], {
    fetchImpl: async (input, init) => {
      if (String(input).includes("slow")) {
        init?.signal?.addEventListener("abort", () => aborted.push(String(input)), { once: true });
        return pendingUntilAbort(init);
      }
      return rpcResponse(init, block);
    }, warn: (message) => { warnings.push(message); }
  })({ retryCount: 0, timeout: 10_000 });
  const result = transport.request({ method, params: blockParams(method) });
  await setImmediate();
  assert.equal(warnings.length, 0);
  t.mock.timers.tick(INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS);
  await setImmediate();
  assert.deepEqual(await result, block);
  assert.equal(Date.now(), INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS);
  assert.deepEqual(aborted, ["https://slow.invalid/"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /cross-check degraded.*slow\.invalid/u);
});

test("an immediate hollow-block rejection does not shorten the wait for the good provider", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const [bad, good] = await Promise.all([zeroGasFixture("dweller-block-full"), zeroGasFixture("eth-rpc-block-full")]);
  let finish: (() => void) | undefined;
  let done = false;
  const transport = createIndexerRpcTransport(["https://hole.invalid", "https://good.invalid"], {
    fetchImpl: async (input, init) => String(input).includes("hole") ? rpcResponse(init, bad.result)
      : new Promise<Response>((resolve) => { finish = () => resolve(rpcResponse(init, good.result)); }),
    warn: () => {}
  })({ retryCount: 0, timeout: 10_000 });
  const request = transport.request({ method: "eth_getBlockByNumber", params: blockParams("eth_getBlockByNumber") })
    .then((result) => { done = true; return result; });
  await setImmediate();
  t.mock.timers.tick(INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS + 1);
  await setImmediate();
  assert.equal(done, false, "a rejection must not start the grace clock");
  assert.ok(finish);
  finish();
  assert.deepEqual(await request, good.result);
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
