import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { FallbackProvider } from "ethers";

import { createRpcProvider } from "./rpc-provider.js";

test("createRpcProvider keeps the primary first and configures ordered failovers", async () => {
  const provider = createRpcProvider({
    rpcUrls: [
      "https://primary.example",
      "https://backup-a.example",
      "https://backup-b.example"
    ],
    rpcFailoverStallMs: 123,
    rpcRequestTimeoutMs: 800
  });

  try {
    assert.ok(provider instanceof FallbackProvider);
    assert.deepEqual(
      provider.providerConfigs.map(({ priority, stallTimeout, weight }) => ({
        priority,
        stallTimeout,
        weight
      })),
      [
        { priority: 1, stallTimeout: 123, weight: 1 },
        { priority: 2, stallTimeout: 123, weight: 1 },
        { priority: 3, stallTimeout: 123, weight: 1 }
      ]
    );
  } finally {
    await provider.destroy();
  }
});

test("createRpcProvider reaches a backup when the primary is blackholed", async () => {
  const primarySockets = new Set();
  const primary = createServer(() => {
    // Deliberately never answer: this is a TCP-level blackhole, not a quick
    // HTTP failure, so the request timeout and failover path are both proven.
  });
  primary.on("connection", (socket) => {
    primarySockets.add(socket);
    socket.on("close", () => primarySockets.delete(socket));
  });
  const backup = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const resultFor = (entry) => ({
        jsonrpc: "2.0",
        id: entry.id,
        result: entry.method === "eth_chainId"
          ? "0x190f1b43"
          : entry.method === "eth_blockNumber"
            ? "0x7b"
            : null
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(
        Array.isArray(payload) ? payload.map(resultFor) : resultFor(payload)
      ));
    });
  });
  await listen(primary);
  await listen(backup);
  const provider = createRpcProvider({
    rpcUrls: [serverUrl(primary), serverUrl(backup)],
    rpcFailoverStallMs: 25,
    rpcRequestTimeoutMs: 150
  });

  try {
    const startedAt = performance.now();
    assert.equal(await provider.getBlockNumber(), 123);
    assert.ok(
      performance.now() - startedAt < 1_000,
      "blackholed primary should fail over in under one second"
    );
  } finally {
    await provider.destroy();
    for (const socket of primarySockets) socket.destroy();
    await close(primary);
    await close(backup);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
