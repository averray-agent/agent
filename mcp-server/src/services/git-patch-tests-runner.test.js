import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitPatchVerificationContract,
  canonicalWitnessEvidence,
  classifyInconclusiveReason,
  GitPatchTestsRunner,
  mapWitnessReport
} from "./git-patch-tests-runner.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { validateVerificationContract } from "../../../witness/src/verification-contract.mjs";

const profile = new VerificationProfileRegistry().get("git-patch-tests-v1", 1);
const target = { repository: "github.com/example/repo", commit: "a".repeat(40) };
const inputs = {
  gitBundle: { sha256: "b".repeat(64), bytes: 10, locator: { kind: "https", url: "https://example.test/source.bundle" }, format: "git-bundle" },
  patch: { sha256: "c".repeat(64), bytes: 10, locator: { kind: "https", url: "https://example.test/change.patch" }, format: "file" },
  testCommand: ["npm", "test"]
};

test("git-patch-tests-v1 translates the public request into the strict offline Witness contract", async () => {
  const contract = await buildGitPatchVerificationContract({ profile, runId: "verify-1", target, inputs });
  assert.deepEqual(contract.subject.acquisition.git_bundle, inputs.gitBundle);
  assert.equal(contract.subject.acquisition.base_commit, target.commit);
  assert.equal(contract.checks.targeted[0].expected_on_base, "fail");
  assert.equal(contract.checks.targeted[0].expected_on_candidate, "pass");
  assert.ok(contract.candidate.protected_paths.includes("package.json"));
  assert.equal(contract.reproducibility.repetitions, 2);
  assert.equal(contract.resources.timeout_seconds, 120);
  assert.deepEqual(validateVerificationContract(contract).issues, []);
});

test("runner uses hash-pinned patch materialization and maps only Witness PASS to decisive pass evidence", async () => {
  const calls = [];
  const runner = new GitPatchTestsRunner({
    makeTemporaryDirectory: async () => "/tmp/verify-fixture",
    removeTemporaryDirectory: async (path) => calls.push(["remove", path]),
    materializeArtifactImpl: async (artifact, destination) => {
      calls.push(["materialize", artifact, destination]);
      return { path: destination };
    },
    executeImpl: async ({ contract, candidatePatch }) => {
      calls.push(["execute", contract, candidatePatch]);
      return {
        schemaVersion: "averray.witness.verification-result/v1",
        verdict: "PASS",
        materialization: { bindingVerified: true },
        sandbox: { imageId: "sha256:fixture" }
      };
    }
  });
  const result = await runner.run({ profile, runId: "verify-1", target, inputs });

  assert.equal(result.status, "decidable");
  assert.equal(result.evidence, "source_binding_verified tests_passed");
  assert.equal(result.sourceBinding.verified, true);
  assert.equal(result.artifactHash, `0x${inputs.patch.sha256}`);
  assert.equal(calls.filter(([name]) => name === "execute").length, 1);
  assert.deepEqual(calls.at(-1), ["remove", "/tmp/verify-fixture"]);
});

test("a decisive Witness label without verified source binding is inconclusive", () => {
  const result = mapWitnessReport({
    report: {
      schemaVersion: "averray.witness.verification-result/v1",
      verdict: "PASS",
      materialization: { bindingVerified: false }
    },
    target,
    inputs
  });

  assert.equal(result.status, "inconclusive");
  assert.equal(result.reason, "ambiguous_evidence");
  assert.equal(result.sourceBinding.verified, false);
  assert.equal(Object.hasOwn(result, "evidence"), false);
});

test("Witness non-decision reasons collapse into the ratified four-reason taxonomy", () => {
  assert.equal(classifyInconclusiveReason({ reason: "artifact_unavailable" }), "target_unreachable");
  assert.equal(classifyInconclusiveReason({ reason: "candidate_caused_nondeterminism_across_repetitions" }), "flaky");
  assert.equal(classifyInconclusiveReason({ reason: "integrity_detection_ambiguous" }), "ambiguous_evidence");
  assert.equal(classifyInconclusiveReason({ reason: "platform_timeout" }), "runner_fault");
});

test("Witness evidence canonicalisation excludes timestamps, paths, durations, and container ids", () => {
  const base = {
    schemaVersion: "averray.witness.verification-result/v1",
    generatedAt: "2026-08-18T12:00:00.000Z",
    candidatePatch: "/tmp/first.patch",
    seconds: 1.2,
    verdict: "PASS",
    baseline: [{ workspaceId: "baseline-1", checks: [{ id: "test", outcome: "fail", containerId: "one", seconds: 1 }] }],
    candidate: [{ workspaceId: "candidate-1", checks: [{ id: "test", outcome: "pass", containerId: "two", seconds: 2 }] }]
  };
  const replay = structuredClone(base);
  replay.generatedAt = "2026-08-18T13:00:00.000Z";
  replay.candidatePatch = "/tmp/other.patch";
  replay.seconds = 99;
  replay.baseline[0].checks[0].containerId = "three";
  replay.candidate[0].checks[0].seconds = 88;

  assert.deepEqual(canonicalWitnessEvidence(replay), canonicalWitnessEvidence(base));
});
