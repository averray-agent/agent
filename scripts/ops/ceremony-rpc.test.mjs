import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CEREMONY_RPC_READ_TIMEOUT_MS,
  CEREMONY_RPC_WRITE_TIMEOUT_MS,
  POLKADOT_HUB_MAINNET_CHAIN_ID,
  createCeremonyRpcContext,
  preflightCeremonyRpc,
  safeCeremonyRpcLabel
} from "./ceremony-rpc.mjs";

const PRIMARY = "https://primary.example/rpc";
const BACKUP = "https://backup.example/rpc";

function response({ status = 200, result, error } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    async json() {
      return { jsonrpc: "2.0", id: 1, result, error };
    }
  };
}

function chainIdResult(chainId = POLKADOT_HUB_MAINNET_CHAIN_ID) {
  return `0x${chainId.toString(16)}`;
}

test("mainnet manifest promotes the official RPC and retains the demoted endpoint as backup", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../deployments/mainnet.json", import.meta.url), "utf8")
  );
  assert.equal(
    manifest.rpcUrl,
    "https://services.polkadothub-rpc.com/mainnet/"
  );
  assert.deepEqual(
    manifest.rpcBackupUrls,
    ["https://eth-rpc.polkadot.io/"]
  );
  assert.equal(manifest.deploymentBlocks.escrowCore, 18_647_902);
});

test("ceremony reads use a patient timeout and labels preserve the endpoint path", () => {
  assert.ok(
    CEREMONY_RPC_READ_TIMEOUT_MS >= 15_000,
    "ceremony getLogs reads must not inherit the sub-second health-probe budget"
  );
  assert.equal(
    safeCeremonyRpcLabel("https://services.polkadothub-rpc.com/mainnet/"),
    "https://services.polkadothub-rpc.com/mainnet/"
  );
  assert.equal(
    safeCeremonyRpcLabel("https://user:password@example.com/rpc?apiKey=secret#fragment"),
    "https://example.com/rpc",
    "full endpoint paths must remain visible without leaking credentials or query secrets"
  );
});

test("testnet manifest records deployment blocks for every deployed contract", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../deployments/testnet.json", import.meta.url), "utf8")
  );
  assert.deepEqual(manifest.deploymentBlocks, {
    treasuryPolicy: 10_689_344,
    strategyAdapterRegistry: 10_689_346,
    agentAccountCore: 10_689_347,
    reputationSbt: 10_689_348,
    discoveryRegistry: 10_689_350,
    escrowCore: 10_689_352
  });
});

test("preflight keeps a healthy manifest primary first", async () => {
  const requested = [];
  const result = await preflightCeremonyRpc({
    manifest: { profile: "mainnet", rpcUrl: PRIMARY, rpcBackupUrls: [BACKUP] },
    phase: "deploy",
    fetchImpl: async (url) => {
      requested.push(url);
      return response({ result: chainIdResult() });
    }
  });

  assert.deepEqual(requested, [PRIMARY]);
  assert.equal(result.selectedUrl, PRIMARY);
  assert.deepEqual(result.rpcUrls, [PRIMARY, BACKUP]);
  assert.equal(result.chainId, POLKADOT_HUB_MAINNET_CHAIN_ID);
});

test("preflight does not let a backup mask a primary returning 404", async () => {
  const requested = [];
  await assert.rejects(
    preflightCeremonyRpc({
      manifest: { profile: "mainnet", rpcUrl: PRIMARY, rpcBackupUrls: [BACKUP] },
      phase: "deploy",
      fetchImpl: async (url) => {
        requested.push(url);
        return response({ status: 404 });
      }
    }),
    /https:\/\/primary\.example\/rpc: HTTP 404 Not Found/u
  );
  assert.deepEqual(requested, [PRIMARY]);
});

test("404 preflight aborts before read or write transports are constructed", async () => {
  let readFactoryCalls = 0;
  let writeFactoryCalls = 0;

  await assert.rejects(
    createCeremonyRpcContext({
      manifest: { profile: "mainnet", rpcUrl: PRIMARY },
      phase: "deploy",
      write: true,
      fetchImpl: async () => response({ status: 404 }),
      readProviderFactory() {
        readFactoryCalls += 1;
      },
      writeBroadcasterFactory() {
        writeFactoryCalls += 1;
      }
    }),
    (error) => {
      assert.match(error.message, /failed before phase deploy/u);
      assert.match(error.message, /https:\/\/primary\.example\/rpc: HTTP 404 Not Found/u);
      assert.match(error.message, /Refusing to continue before provider creation, secret access, or transaction broadcast/u);
      return true;
    }
  );

  assert.equal(readFactoryCalls, 0);
  assert.equal(writeFactoryCalls, 0);
});

test("wrong-chain endpoints cannot enter a ceremony phase", async () => {
  await assert.rejects(
    preflightCeremonyRpc({
      manifest: { profile: "mainnet", rpcUrl: PRIMARY },
      phase: "finalize",
      fetchImpl: async () => response({ result: chainIdResult(420420417) })
    }),
    /wrong chainId 420420417; expected 420420419/u
  );
});

test("testnet ceremonies retain the testnet chain assertion", async () => {
  const result = await preflightCeremonyRpc({
    manifest: {
      profile: "testnet",
      rpcUrl: "https://testnet.example/rpc"
    },
    phase: "all",
    fetchImpl: async () => response({ result: chainIdResult(420420417) })
  });
  assert.equal(result.chainId, 420420417);
});

test("write context uses the preflight order and a patient write timeout", async () => {
  const constructed = [];
  const context = await createCeremonyRpcContext({
    manifest: { profile: "mainnet", rpcUrl: PRIMARY, rpcBackupUrls: [BACKUP] },
    phase: "deploy",
    write: true,
    fetchImpl: async () => response({ result: chainIdResult() }),
    readProviderFactory(config) {
      constructed.push(["read", config]);
      return "read-provider";
    },
    writeBroadcasterFactory(config) {
      constructed.push(["write", config]);
      return "write-broadcaster";
    }
  });

  assert.equal(context.provider, "read-provider");
  assert.equal(context.writeBroadcaster, "write-broadcaster");
  assert.deepEqual(constructed.map(([kind]) => kind), ["read", "write"]);
  assert.deepEqual(constructed[0][1].rpcUrls, [PRIMARY, BACKUP]);
  assert.equal(constructed[1][1].rpcWriteRequestTimeoutMs, CEREMONY_RPC_WRITE_TIMEOUT_MS);
  assert.ok(constructed[1][1].rpcWriteRequestTimeoutMs >= 15_000);
});
