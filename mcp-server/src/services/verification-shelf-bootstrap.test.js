import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { GitPatchTestsRunner } from "./git-patch-tests-runner.js";
import { createVerificationShelf } from "./verification-shelf.js";

function assertNoStaticWitnessImport(source) {
  assert.doesNotMatch(
    source,
    /^import\s.+from\s+["'][^"']*witness\/src\//mu,
    "Witness must remain outside the backend startup module graph"
  );
}

test("backend verification shelf boots and fails closed when Witness modules cannot resolve", async () => {
  const missing = Object.assign(new Error("Cannot find module /witness/src/artifacts.mjs"), {
    code: "ERR_MODULE_NOT_FOUND"
  });
  const warnings = [];
  const runner = new GitPatchTestsRunner({
    loadWitnessModulesImpl: async () => { throw missing; }
  });
  const { verificationRunService } = await createVerificationShelf({
    stateStore: new MemoryStateStore(),
    runner,
    logger: { warn: (...args) => warnings.push(args) }
  });

  const [profile] = verificationRunService.listProfiles();
  assert.equal(profile.ref, "git-patch-tests-v1@1");
  assert.deepEqual(profile.availability, {
    status: "unavailable",
    reasonCode: "witness_modules_unavailable",
    reason: "The Witness runtime modules are not installed or could not be loaded by this backend."
  });
  assert.equal(warnings.length, 1);
  await assert.rejects(
    () => verificationRunService.createRun({
      profile: "git-patch-tests-v1",
      profileVersion: 1
    }),
    (error) => error.code === "verification_profile_unavailable"
      && error.statusCode === 503
      && /Witness runtime modules/u.test(error.message)
  );
});

test("backend startup module graph has no static Witness import, including under mutation", () => {
  const source = readFileSync(new URL("./git-patch-tests-runner.js", import.meta.url), "utf8");
  assertNoStaticWitnessImport(source);

  const deliberatelyMutated = `import { materializeArtifact } from "../../../witness/src/artifacts.mjs";\n${source}`;
  assert.throws(() => assertNoStaticWitnessImport(deliberatelyMutated), /startup module graph/u);
});
