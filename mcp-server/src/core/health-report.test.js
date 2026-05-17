import test from "node:test";
import assert from "node:assert/strict";

import { buildHealthReport } from "./health-report.js";
import { loadMutationBackendConfig } from "./mutation-backend.js";

const AUTH_CONFIG = {
  mode: "strict",
  domain: "health.test",
  chainId: "1"
};

const STATE_STORE_OK = {
  async healthCheck() {
    return { ok: true, backend: "memory", mode: "ephemeral" };
  }
};

const PIMLICO_DISABLED = {
  async healthCheck() {
    return { ok: true, backend: "pimlico", enabled: false, mode: "disabled" };
  }
};

test("health report keeps service healthy while required treasury capability is unavailable", async () => {
  const gateway = {
    isEnabled: () => false,
    async healthCheck() {
      return { ok: true, backend: "blockchain", enabled: false, mode: "disabled" };
    }
  };

  const report = await buildHealthReport({
    stateStore: STATE_STORE_OK,
    gateway,
    pimlicoClient: PIMLICO_DISABLED,
    mutationBackendConfig: loadMutationBackendConfig({
      NODE_ENV: "production",
      MUTATION_BACKEND: "required"
    }),
    authConfig: AUTH_CONFIG
  });

  assert.equal(report.status, "ok");
  assert.equal(report.serviceHealth, "ok");
  assert.equal(report.serviceComponents.stateStore.ok, true);
  assert.equal(report.capabilityHealth.blockchain, "disabled");
  assert.equal(report.capabilityHealth.treasuryMutations, "unavailable");
  assert.equal(report.capabilityDetails.treasuryMutations.reason, "blockchain gateway is disabled");
  assert.ok(report.warnings.some((warning) => warning.code === "treasury_mutations_unavailable"));
});

test("health report labels memory mutation mode as degraded rather than chain-backed", async () => {
  const gateway = {
    isEnabled: () => false,
    async healthCheck() {
      return { ok: true, backend: "blockchain", enabled: false, mode: "disabled" };
    }
  };

  const report = await buildHealthReport({
    stateStore: STATE_STORE_OK,
    gateway,
    pimlicoClient: PIMLICO_DISABLED,
    mutationBackendConfig: loadMutationBackendConfig({
      NODE_ENV: "development",
      MUTATION_BACKEND: "memory"
    }),
    authConfig: AUTH_CONFIG
  });

  assert.equal(report.serviceHealth, "ok");
  assert.equal(report.capabilityHealth.blockchain, "disabled");
  assert.equal(report.capabilityHealth.treasuryMutations, "degraded");
  assert.equal(report.capabilityDetails.treasuryMutations.reason, "memory backend allowed");
});

test("health report marks chain-backed treasury and running XCM observer as live", async () => {
  const gateway = {
    isEnabled: () => true,
    async healthCheck() {
      return {
        ok: true,
        backend: "blockchain",
        enabled: true,
        blockNumber: 123,
        signerConfigured: true,
        xcmWrapperConfigured: true
      };
    }
  };

  const report = await buildHealthReport({
    stateStore: STATE_STORE_OK,
    gateway,
    pimlicoClient: PIMLICO_DISABLED,
    mutationBackendConfig: loadMutationBackendConfig({
      NODE_ENV: "production",
      MUTATION_BACKEND: "required"
    }),
    authConfig: AUTH_CONFIG,
    xcmObservationRelay: {
      async getStatus() {
        return { enabled: true, running: true, syncing: false, feedUrl: "https://index.example/xcm" };
      }
    }
  });

  assert.equal(report.serviceHealth, "ok");
  assert.equal(report.capabilityHealth.blockchain, "enabled");
  assert.equal(report.capabilityHealth.treasuryMutations, "available");
  assert.equal(report.capabilityHealth.xcmObserver, "live");
  assert.equal(
    report.warnings.some((warning) => warning.code.startsWith("treasury_mutations_")),
    false
  );
});

test("health report degrades service health when state store is unavailable", async () => {
  const report = await buildHealthReport({
    stateStore: {
      async healthCheck() {
        return { ok: false, backend: "redis", mode: "durable", error: "down" };
      }
    },
    gateway: {
      isEnabled: () => false,
      async healthCheck() {
        return { ok: true, backend: "blockchain", enabled: false, mode: "disabled" };
      }
    },
    pimlicoClient: PIMLICO_DISABLED,
    mutationBackendConfig: loadMutationBackendConfig({
      NODE_ENV: "production",
      MUTATION_BACKEND: "required"
    }),
    authConfig: AUTH_CONFIG
  });

  assert.equal(report.status, "degraded");
  assert.equal(report.serviceHealth, "degraded");
  assert.equal(report.serviceComponents.stateStore.ok, false);
});
