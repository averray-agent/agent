import assert from "node:assert/strict";
import test from "node:test";

import { GitPatchTestsRunner } from "./git-patch-tests-runner.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";

const PROFILE = new VerificationProfileRegistry().get("git-patch-tests-v1", 1);
const TARGET = {
  repository: "github.com/example/project",
  commit: "a".repeat(40)
};
const INPUTS = {
  bundle: {
    sha256: "b".repeat(64),
    bytes: 100,
    locator: { kind: "https", url: "https://example.test/source.bundle" },
    format: "git-bundle"
  },
  patch: {
    sha256: "c".repeat(64),
    bytes: 50,
    locator: { kind: "https", url: "https://example.test/change.patch" },
    format: "file"
  },
  testCommand: ["npm", "test"]
};

function runnerWithReport(report, observed = {}) {
  return new GitPatchTestsRunner({
    materialize: async () => {},
    execute: async (input) => {
      observed.contract = input.contract;
      return report;
    }
  });
}

test("git-patch-tests-v1 binds the offline bundle and passes only conclusive Witness PASS", async () => {
  const observed = {};
  const runner = runnerWithReport({
    verdict: "PASS",
    materialization: {
      bindingVerified: true,
      commit: TARGET.commit,
      tree: "tree-id"
    },
    sandbox: { imageId: "sha256:witness" }
  }, observed);
  const result = await runner.run({
    runId: `verify_${"d".repeat(64)}`,
    profile: PROFILE,
    target: TARGET,
    inputs: INPUTS
  });
  assert.equal(result.status, "conclusive");
  assert.equal(result.evidence, "pass");
  assert.equal(result.execution.sourceBinding.verified, true);
  assert.equal(observed.contract.subject.acquisition.git_bundle, INPUTS.bundle);
  assert.deepEqual(observed.contract.checks.targeted[0].command, ["npm", "test"]);
  assert.equal(observed.contract.resources.timeout_seconds, 75);
  assert.equal(observed.contract.reproducibility.repetitions, 2);
});

test("Witness timeout/resource breach is inconclusive runner_fault, never artifact failure", async () => {
  const runner = runnerWithReport({
    verdict: "INCONCLUSIVE",
    attribution: "candidate",
    reason: "candidate_exceeded_resource_limit",
    details: "candidate check exceeded timeout_seconds"
  });
  const result = await runner.run({
    runId: `verify_${"e".repeat(64)}`,
    profile: PROFILE,
    target: TARGET,
    inputs: INPUTS
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.reason, "runner_fault");
  assert.notEqual(result.status, "conclusive");
  assert.notEqual(result.evidence, "fail");
});

test("unreachable target and ambiguous runner evidence use the exact public taxonomy", async () => {
  const unreachable = new GitPatchTestsRunner({
    materialize: async () => { throw new Error("fixture host unavailable"); },
    execute: async () => { throw new Error("must not run"); }
  });
  const targetResult = await unreachable.run({
    runId: `verify_${"f".repeat(64)}`,
    profile: PROFILE,
    target: TARGET,
    inputs: INPUTS
  });
  assert.equal(targetResult.reason, "target_unreachable");

  const ambiguous = new GitPatchTestsRunner({
    materialize: async () => {},
    execute: async () => { throw new Error("judging command cannot be resolved"); }
  });
  const ambiguousResult = await ambiguous.run({
    runId: `verify_${"0".repeat(64)}`,
    profile: PROFILE,
    target: TARGET,
    inputs: INPUTS
  });
  assert.equal(ambiguousResult.reason, "ambiguous_evidence");
});
