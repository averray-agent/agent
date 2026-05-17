import test from "node:test";
import assert from "node:assert/strict";

import {
  assertMutationBackendAvailable,
  getMutationBackendStatus,
  loadMutationBackendConfig
} from "./mutation-backend.js";
import { ChainBackendRequiredError, ConfigError } from "./errors.js";

test("loadMutationBackendConfig defaults production to required", () => {
  const config = loadMutationBackendConfig({ NODE_ENV: "production" });

  assert.equal(config.mode, "required");
  assert.equal(config.defaulted, true);
  assert.equal(config.requiresChain, true);
  assert.equal(config.allowsMemory, false);
});

test("loadMutationBackendConfig defaults non-production to memory", () => {
  const config = loadMutationBackendConfig({ NODE_ENV: "development" });

  assert.equal(config.mode, "memory");
  assert.equal(config.defaulted, true);
  assert.equal(config.requiresChain, false);
  assert.equal(config.allowsMemory, true);
});

test("loadMutationBackendConfig rejects unknown modes", () => {
  assert.throws(
    () => loadMutationBackendConfig({ MUTATION_BACKEND: "maybe" }),
    ConfigError
  );
});

test("mutation backend allows memory mode without probing gateway", async () => {
  let probed = false;
  const status = await getMutationBackendStatus({
    config: loadMutationBackendConfig({ MUTATION_BACKEND: "memory" }),
    gateway: {
      isEnabled: () => {
        probed = true;
        return false;
      }
    },
    route: "/account/fund"
  });

  assert.equal(status.ok, true);
  assert.equal(status.chainRequired, false);
  assert.equal(probed, false);
});

test("mutation backend rejects required mode when gateway is disabled", async () => {
  await assert.rejects(
    () => assertMutationBackendAvailable({
      config: loadMutationBackendConfig({ MUTATION_BACKEND: "required" }),
      gateway: { isEnabled: () => false },
      route: "/account/fund"
    }),
    (error) => {
      assert.ok(error instanceof ChainBackendRequiredError);
      assert.equal(error.code, "chain_backend_required");
      assert.equal(error.statusCode, 503);
      assert.equal(error.details.reason, "blockchain gateway is disabled");
      assert.equal(error.details.route, "/account/fund");
      return true;
    }
  );
});

test("mutation backend rejects chain mode when health check fails", async () => {
  const status = await getMutationBackendStatus({
    config: loadMutationBackendConfig({ MUTATION_BACKEND: "chain" }),
    gateway: {
      isEnabled: () => true,
      healthCheck: async () => ({
        ok: false,
        enabled: true,
        backend: "blockchain",
        error: "rpc unavailable"
      })
    },
    route: "/payments/send"
  });

  assert.equal(status.ok, false);
  assert.equal(status.reason, "rpc unavailable");
  assert.equal(status.gatewayStatus.error, "rpc unavailable");
});

test("mutation backend allows required mode when gateway health is ok", async () => {
  const status = await assertMutationBackendAvailable({
    config: loadMutationBackendConfig({ MUTATION_BACKEND: "required" }),
    gateway: {
      isEnabled: () => true,
      healthCheck: async () => ({
        ok: true,
        enabled: true,
        backend: "blockchain",
        blockNumber: 123
      })
    },
    route: "/account/repay"
  });

  assert.equal(status.ok, true);
  assert.equal(status.chainRequired, true);
  assert.equal(status.chainAvailable, true);
  assert.equal(status.gatewayStatus.blockNumber, 123);
});
