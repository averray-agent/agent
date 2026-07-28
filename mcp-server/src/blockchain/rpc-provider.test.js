import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { FallbackProvider, Transaction, Wallet, keccak256 } from "ethers";

import {
  bindSignerToWriteBroadcaster,
  createRpcProvider,
  createWriteRpcBroadcaster,
  describeRpcProvider,
  WriteRpcBroadcaster
} from "./rpc-provider.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a004497e5da795437b4466ad5c2af1c6a6d1dcb1b1ce36b9";

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

test("write broadcaster waits through a two-second send response and settles on the first endpoint", async () => {
  const signedTransaction = await new Wallet(TEST_PRIVATE_KEY).signTransaction({
    chainId: 1,
    nonce: 0,
    gasLimit: 21_000,
    gasPrice: 1,
    to: "0x0000000000000000000000000000000000000001",
    value: 0
  });
  const expectedHash = keccak256(signedTransaction);
  const decodedTransaction = Transaction.from(signedTransaction);
  let sendAttempts = 0;
  let accepted = false;
  const rpc = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const entries = Array.isArray(payload) ? payload : [payload];
      const hasBroadcast = entries.some((entry) => entry.method === "eth_sendRawTransaction");
      if (hasBroadcast) {
        sendAttempts += 1;
        accepted = true;
      }
      const results = entries.map((entry) => ({
        jsonrpc: "2.0",
        id: entry.id,
        result: entry.method === "eth_chainId"
          ? "0x1"
          : entry.method === "eth_blockNumber"
            ? "0x10"
          : entry.method === "eth_sendRawTransaction"
            ? expectedHash
            : entry.method === "eth_getTransactionReceipt"
              ? accepted
                ? rpcReceipt(decodedTransaction, expectedHash)
                : null
            : null
      }));
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
      }, hasBroadcast ? 2_000 : 0);
    });
  });
  await listen(rpc);
  const broadcaster = createWriteRpcBroadcaster({
    rpcUrls: [serverUrl(rpc)],
    rpcWriteRequestTimeoutMs: 15_000
  });

  try {
    const transaction = await broadcaster.broadcastTransaction(signedTransaction);
    assert.equal(transaction.hash, expectedHash);
    assert.equal(describeRpcProvider(transaction.provider), serverUrl(rpc));
    assert.equal((await transaction.wait()).status, 1);
    assert.equal(sendAttempts, 1);
  } finally {
    await broadcaster.destroy();
    await close(rpc);
  }
});

test("write failover returns a transaction already visible on the next endpoint without rebroadcasting", async () => {
  const signedTransaction = await signedTestTransaction();
  const expectedHash = keccak256(signedTransaction);
  const primary = fakeWriteProvider({
    broadcastError: Object.assign(new Error("request timeout"), { code: "TIMEOUT" })
  });
  const knownTransaction = {
    hash: expectedHash,
    async wait() {
      return { status: 1 };
    }
  };
  const backup = fakeWriteProvider({ knownTransaction });
  const broadcaster = new WriteRpcBroadcaster([primary, backup]);

  assert.equal(
    await broadcaster.broadcastTransaction(signedTransaction),
    knownTransaction
  );
  assert.equal(primary.broadcastCalls, 1);
  assert.equal(backup.broadcastCalls, 0);
});

test("write failover refuses a blind rebroadcast when the sender nonce has advanced", async () => {
  const signedTransaction = await signedTestTransaction();
  const primary = fakeWriteProvider({
    broadcastError: Object.assign(new Error("request timeout"), { code: "TIMEOUT" })
  });
  const backup = fakeWriteProvider({ pendingNonce: 1 });
  const broadcaster = new WriteRpcBroadcaster([primary, backup]);

  await assert.rejects(
    broadcaster.broadcastTransaction(signedTransaction),
    (error) => error.code === "TRANSACTION_NONCE_AMBIGUOUS"
      && /already pending or mined/u.test(error.message)
  );
  assert.equal(primary.broadcastCalls, 1);
  assert.equal(backup.broadcastCalls, 0);
});

test("bound signer keeps transaction preparation on the read provider and broadcasts through the write transport", async () => {
  const readMethods = [];
  const readRpc = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const entries = Array.isArray(payload) ? payload : [payload];
      const results = entries.map((entry) => {
        readMethods.push(entry.method);
        return {
          jsonrpc: "2.0",
          id: entry.id,
          result: entry.method === "eth_chainId" ? "0x1" : null
        };
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
    });
  });
  await listen(readRpc);
  const readProvider = createRpcProvider({ rpcUrls: [serverUrl(readRpc)] });
  const broadcasts = [];
  const writeBroadcaster = {
    async broadcastTransaction(signedTransaction) {
      broadcasts.push(signedTransaction);
      return { hash: keccak256(signedTransaction) };
    }
  };
  const signer = bindSignerToWriteBroadcaster(
    new Wallet(TEST_PRIVATE_KEY, readProvider),
    readProvider,
    writeBroadcaster
  );

  try {
    const transaction = await signer.sendTransaction({
      chainId: 1,
      nonce: 0,
      gasLimit: 21_000,
      maxFeePerGas: 1,
      maxPriorityFeePerGas: 1,
      type: 2,
      to: "0x0000000000000000000000000000000000000001",
      value: 0
    });
    assert.equal(transaction.hash, keccak256(broadcasts[0]));
    assert.equal(broadcasts.length, 1);
    assert.ok(readMethods.includes("eth_chainId"));
    assert.equal(readMethods.includes("eth_sendRawTransaction"), false);
  } finally {
    await readProvider.destroy();
    await close(readRpc);
  }
});

function signedTestTransaction() {
  return new Wallet(TEST_PRIVATE_KEY).signTransaction({
    chainId: 1,
    nonce: 0,
    gasLimit: 21_000,
    gasPrice: 1,
    to: "0x0000000000000000000000000000000000000001",
    value: 0
  });
}

function fakeWriteProvider({
  broadcastError,
  knownTransaction = null,
  receipt = null,
  pendingNonce = 0,
  latestNonce = 0
} = {}) {
  return {
    broadcastCalls: 0,
    async broadcastTransaction() {
      this.broadcastCalls += 1;
      if (broadcastError) {
        throw broadcastError;
      }
      return knownTransaction;
    },
    async getTransaction() {
      return knownTransaction;
    },
    async getTransactionReceipt() {
      return receipt;
    },
    async getTransactionCount(_address, blockTag) {
      return blockTag === "pending" ? pendingNonce : latestNonce;
    }
  };
}

function rpcReceipt(transaction, transactionHash) {
  return {
    blockHash: `0x${"ab".repeat(32)}`,
    blockNumber: "0x10",
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    from: transaction.from,
    gasUsed: "0x5208",
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    to: transaction.to,
    transactionHash,
    transactionIndex: "0x0",
    type: "0x0"
  };
}

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
