import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODE_CHANGE_CREATION_REASONS,
  CodeChangeCreationRefusedError,
  createCodeChangeJob,
  prepareCodeChangeJob,
  publishCodeChangeJob
} from "../src/code-change-publication.mjs";

const witnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = resolve(witnessRoot, "examples/averray-send-test");
const contract = JSON.parse(await readFile(resolve(exampleRoot, "contract-testnet-v1.1.json"), "utf8"));
const job = {
  id: contract.job.id,
  category: "coding",
  tier: "starter",
  lane: "benchmark-showcase",
  rewardAsset: "USDC",
  rewardAmount: 1,
  inputSchemaRef: "schema://jobs/coding-input",
  claimTtlSeconds: 3600,
  retryLimit: 1
};

function preflight(overrides = {}) {
  return {
    commit: contract.subject.acquisition.base_commit,
    classification: "HERMETIC",
    classificationReason: null,
    basePassed: true,
    attempts: [{ stdout: "", stderr: "" }],
    ...overrides
  };
}

function freeze(overrides = {}) {
  return {
    valid: true,
    issues: [],
    evidence: {
      checks: [{
        id: contract.checks.hidden.id,
        kind: "hidden",
        expected: "fail",
        outcome: "fail"
      }]
    },
    ...overrides
  };
}

test("creation executes preflight before freeze and publishes a digest-bound shape", async () => {
  const calls = [];
  let posted;
  const { prepared, publication } = await createCodeChangeJob({ contract, job }, {
    cwd: exampleRoot,
    apiUrl: "https://testnet.api.example",
    token: "test-token"
  }, {
    runPreflight: async (options) => {
      calls.push("preflight");
      assert.equal(options.commit, contract.subject.acquisition.base_commit);
      return preflight();
    },
    validateAtFreeze: async () => {
      calls.push("freeze");
      return freeze();
    },
    fetchImpl: async (_url, options = {}) => {
      calls.push(options.method === "POST" ? "publish" : "readback");
      if (options.method === "POST") posted = JSON.parse(options.body);
      return new Response(JSON.stringify(
        options.method === "POST" ? posted : { jobs: [posted] }
      ), { status: options.method === "POST" ? 201 : 200 });
    }
  });

  assert.deepEqual(calls, ["preflight", "freeze", "publish", "readback"]);
  assert.equal(publication.definition.id, prepared.job.id);
  assert.equal(prepared.job.codeChange.contractState, "frozen");
  assert.equal(prepared.job.codeChange.contractDigest, prepared.contractDigest);
  assert.equal(prepared.job.outputSchemaRef, "schema://jobs/patch-submission-output");
  assert.equal(prepared.job.codeChange.preflight.result, "EXECUTABLE");
});

test("REQUIRES_NETWORK is refused with a named reason before freeze", async () => {
  let freezeCalls = 0;
  await assert.rejects(
    prepareCodeChangeJob({ contract, job }, {}, {
      runPreflight: async () => preflight({
        classification: "REQUIRES_NETWORK",
        classificationReason: "fetch failed",
        basePassed: false
      }),
      validateAtFreeze: async () => {
        freezeCalls += 1;
        return freeze();
      }
    }),
    (error) => error instanceof CodeChangeCreationRefusedError &&
      error.reason === CODE_CHANGE_CREATION_REASONS.PREFLIGHT_REQUIRES_NETWORK
  );
  assert.equal(freezeCalls, 0);
});

test("a malformed contract is refused before preflight or freeze", async () => {
  const malformed = structuredClone(contract);
  delete malformed.resources.timeout_seconds;
  let preflightCalls = 0;
  let freezeCalls = 0;
  await assert.rejects(
    prepareCodeChangeJob({ contract: malformed, job }, {}, {
      runPreflight: async () => {
        preflightCalls += 1;
        return preflight();
      },
      validateAtFreeze: async () => {
        freezeCalls += 1;
        return freeze();
      }
    }),
    (error) => error instanceof CodeChangeCreationRefusedError &&
      error.reason === CODE_CHANGE_CREATION_REASONS.CONTRACT_SCHEMA_REJECTED &&
      error.details.issues.some((issue) => issue.path === "resources.timeout_seconds")
  );
  assert.equal(preflightCalls, 0);
  assert.equal(freezeCalls, 0);
});

test("privileged service and private credential checks are structural refusals", async () => {
  const cases = [
    ["DOCKER_START_FAILED: cannot connect to the Docker daemon", CODE_CHANGE_CREATION_REASONS.PREFLIGHT_PRIVILEGED_SERVICE],
    ["HARNESS_AUTH_FAILED: missing CI credential", CODE_CHANGE_CREATION_REASONS.PREFLIGHT_PRIVATE_CREDENTIAL]
  ];
  for (const [classificationReason, reason] of cases) {
    await assert.rejects(
      prepareCodeChangeJob({ contract, job }, {}, {
        runPreflight: async () => preflight({
          classification: "UNMATERIALIZABLE",
          classificationReason,
          basePassed: false,
          attempts: []
        })
      }),
      (error) => error instanceof CodeChangeCreationRefusedError && error.reason === reason
    );
  }
});

test("publication reads the board back and proves the frozen digest survived", async () => {
  const prepared = await prepareCodeChangeJob({ contract, job }, {}, {
    runPreflight: async () => preflight(),
    validateAtFreeze: async () => freeze()
  });
  const calls = [];
  const result = await publishCodeChangeJob(prepared, {
    apiUrl: "https://testnet.api.example",
    token: "test-token"
  }, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") {
        return new Response(JSON.stringify(prepared.job), { status: 201 });
      }
      return new Response(JSON.stringify({ jobs: [prepared.job] }), { status: 200 });
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/admin\/jobs$/u);
  assert.match(calls[1].url, /\/admin\/jobs$/u);
  assert.equal(result.definition.codeChange.contractDigest, prepared.contractDigest);
});
