import test from "node:test";
import assert from "node:assert/strict";

import {
  POLKADOT_HUB_MAINNET_CHAIN_ID,
  assertMainnetSignerPosture,
  assertChainIdMatchesRpc
} from "./startup-guards.js";

const TESTNET_CHAIN_ID = 420420417;

const enabledGateway = (config = {}) => ({ isEnabled: () => true, config });
const disabledGateway = (config = {}) => ({ isEnabled: () => false, config });

// ─── B-02: mainnet SIGNER_BACKEND=kms posture ───────────────────────────

test("B-02: mainnet + gateway live + SIGNER_BACKEND=local → refuses to boot", () => {
  assert.throws(
    () =>
      assertMainnetSignerPosture({
        authConfig: { chainId: POLKADOT_HUB_MAINNET_CHAIN_ID },
        gateway: enabledGateway({ signerBackend: "local" }),
        env: {}
      }),
    /Mainnet .* requires SIGNER_BACKEND=kms/u
  );
});

test("B-02: mainnet + gateway live + SIGNER_BACKEND=kms → passes", () => {
  assert.doesNotThrow(() =>
    assertMainnetSignerPosture({
      authConfig: { chainId: POLKADOT_HUB_MAINNET_CHAIN_ID },
      gateway: enabledGateway({ signerBackend: "kms" }),
      env: {}
    })
  );
});

test("B-02: TestNet + local signer → no-op (local keys are intentional off mainnet)", () => {
  assert.doesNotThrow(() =>
    assertMainnetSignerPosture({
      authConfig: { chainId: TESTNET_CHAIN_ID },
      gateway: enabledGateway({ signerBackend: "local" }),
      env: {}
    })
  );
});

test("B-02: mainnet but gateway disabled → no-op (nothing signs on-chain)", () => {
  assert.doesNotThrow(() =>
    assertMainnetSignerPosture({
      authConfig: { chainId: POLKADOT_HUB_MAINNET_CHAIN_ID },
      gateway: disabledGateway({ signerBackend: "local" }),
      env: {}
    })
  );
});

test("B-02: falls back to env.SIGNER_BACKEND when gateway.config lacks it", () => {
  assert.throws(
    () =>
      assertMainnetSignerPosture({
        authConfig: { chainId: POLKADOT_HUB_MAINNET_CHAIN_ID },
        gateway: enabledGateway({}),
        env: { SIGNER_BACKEND: "local" }
      }),
    /SIGNER_BACKEND=kms/u
  );
});

// ─── D-02: chain-id matches the RPC ─────────────────────────────────────

test("D-02: configured == RPC-reported → passes and logs verified", async () => {
  const logs = [];
  await assert.doesNotReject(
    assertChainIdMatchesRpc({
      authConfig: { chainId: TESTNET_CHAIN_ID },
      gateway: {
        isEnabled: () => true,
        provider: { getNetwork: async () => ({ chainId: BigInt(TESTNET_CHAIN_ID) }) },
        config: { rpcUrl: "https://rpc.example" }
      },
      logger: { info: (o, m) => logs.push(m), warn: () => {} }
    })
  );
  assert.ok(logs.includes("startup.chain_id_verified"));
});

test("D-02: configured != RPC-reported → refuses to boot (mismatch)", async () => {
  await assert.rejects(
    assertChainIdMatchesRpc({
      authConfig: { chainId: TESTNET_CHAIN_ID },
      gateway: {
        isEnabled: () => true,
        provider: { getNetwork: async () => ({ chainId: BigInt(POLKADOT_HUB_MAINNET_CHAIN_ID) }) },
        config: { rpcUrl: "https://rpc.example" }
      }
    }),
    /Chain-id mismatch: configured AUTH_CHAIN_ID=420420417 .* reports chain id 420420419/u
  );
});

test("D-02: gateway disabled → no-op", async () => {
  await assert.doesNotReject(
    assertChainIdMatchesRpc({
      authConfig: { chainId: TESTNET_CHAIN_ID },
      gateway: { isEnabled: () => false, provider: { getNetwork: async () => { throw new Error("should not be called"); } } }
    })
  );
});

test("D-02: no configured chain id (0) → no-op", async () => {
  await assert.doesNotReject(
    assertChainIdMatchesRpc({
      authConfig: { chainId: 0 },
      gateway: { isEnabled: () => true, provider: { getNetwork: async () => { throw new Error("should not be called"); } } }
    })
  );
});

test("D-02: RPC unreachable → warns and continues (does NOT block boot)", async () => {
  const logs = [];
  await assert.doesNotReject(
    assertChainIdMatchesRpc({
      authConfig: { chainId: TESTNET_CHAIN_ID },
      gateway: {
        isEnabled: () => true,
        provider: { getNetwork: async () => { throw new Error("ECONNREFUSED"); } },
        config: { rpcUrl: "https://rpc.down" }
      },
      logger: { info: () => {}, warn: (o, m) => logs.push(m) }
    })
  );
  assert.ok(logs.includes("startup.chain_id_unverified"));
});
