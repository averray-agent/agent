import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { createVerificationShelf } from "./verification-shelf.js";

function assertNoStaticWitnessImport(source) {
  assert.doesNotMatch(
    source,
    /^import\s.+from\s+["'][^"']*witness\/src\//mu,
    "Witness must remain outside the backend startup module graph"
  );
}

test("backend verification shelf boots, profiles, and queues without loading Witness", async () => {
  const stateStore = new MemoryStateStore();
  const { verificationRunFinalizer, verificationRunService } = await createVerificationShelf({
    stateStore,
    paymentGate: {
      async authorize() {
        return {
          id: "authorization-one",
          customer: "0x1111111111111111111111111111111111111111",
          amountRaw: "5000000",
          asset: "USDC",
          network: "eip155:8453"
        };
      }
    },
    env: {}
  });

  const [profile, mcpProfile] = verificationRunService.listProfiles();
  assert.equal(profile.ref, "git-patch-tests-v1@1");
  assert.deepEqual(profile.availability, { status: "available" });
  assert.equal(mcpProfile.ref, "mcp-failure-semantics-v1@1");
  assert.equal(mcpProfile.availability.status, "unavailable");
  assert.equal(mcpProfile.availability.reason, "isolated_mcp_prober_not_configured");
  assert.ok(verificationRunFinalizer);
  const queued = await verificationRunService.createRun({
    profile: "git-patch-tests-v1",
    profileVersion: 1,
    target: { repository: "github.com/example/project", commit: "1".repeat(40) },
    inputs: {
      gitBundle: { sha256: "2".repeat(64), bytes: 100, locator: { kind: "https", url: "https://example.test/source.bundle" }, format: "git-bundle" },
      patch: { sha256: "3".repeat(64), bytes: 50, locator: { kind: "https", url: "https://example.test/change.patch" }, format: "file" },
      testCommand: ["npm", "test"]
    },
    paymentProof: "proof"
  });
  assert.equal(queued.status, "queued");
  assert.equal((await stateStore.getVerificationRun(queued.runId)).status, "queued");
});

test("backend startup module graph has no Witness runner dependency, including under mutation", () => {
  const sources = [
    readFileSync(new URL("./verification-shelf.js", import.meta.url), "utf8"),
    readFileSync(new URL("./verification-run-service.js", import.meta.url), "utf8")
  ];
  for (const source of sources) {
    assertNoStaticWitnessImport(source);
    assert.doesNotMatch(source, /git-patch-tests-runner/u);
  }

  const deliberatelyMutated = `import { materializeArtifact } from "../../../witness/src/artifacts.mjs";\n${sources[0]}`;
  assert.throws(() => assertNoStaticWitnessImport(deliberatelyMutated), /startup module graph/u);
});

test("an unavailable MCP control socket degrades profile 2 without blocking backend verification startup", async () => {
  const errors = [];
  const shelf = await createVerificationShelf({
    stateStore: new MemoryStateStore(),
    paymentGate: { async authorize() { throw new Error("not used"); } },
    authConfig: {
      jwtBackend: "hmac",
      signingSecret: "mcp-shelf-test-secret-that-is-long-enough-123",
      secrets: ["mcp-shelf-test-secret-that-is-long-enough-123"]
    },
    env: {
      MCP_PROBER_URL: "http://mcp-prober:8080",
      MCP_EGRESS_GRANT_SOCKET: "/path-that-does-not-exist/and-cannot-be-created/grants.sock"
    },
    logger: { error(entry, message) { errors.push({ entry, message }); } }
  });
  const profiles = shelf.verificationRunService.listProfiles();
  assert.equal(profiles.find(({ ref }) => ref === "git-patch-tests-v1@1").availability.status, "available");
  assert.equal(profiles.find(({ ref }) => ref === "mcp-failure-semantics-v1@1").availability.status, "unavailable");
  assert.equal(shelf.mcpEgressGrantVerifier, undefined);
  assert.equal(errors.length, 1);
});
