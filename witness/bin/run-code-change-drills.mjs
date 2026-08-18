#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CODE_CHANGE_CREATION_REASONS,
  prepareCodeChangeJob,
  publishCodeChangeJob
} from "../src/code-change-publication.mjs";
import {
  CODE_CHANGE_JOB_SCHEMA_VERSION,
  FROZEN_CONTRACT_DIGEST_ALGORITHM,
  hashFrozenVerificationContract,
  normalizeCodeChangeDefinition
} from "../../mcp-server/src/core/code-change-job.js";
import { validateStructuredSubmission } from "../../mcp-server/src/core/job-schema-registry.js";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WITNESS_ROOT, "..");
const CONTRACT = JSON.parse(await readFile(
  resolve(WITNESS_ROOT, "examples/averray-send-test/contract-testnet-v1.1.json"),
  "utf8"
));
const JOB = {
  id: CONTRACT.job.id,
  title: "Code change: unitless duration parsing",
  category: "coding",
  tier: "starter",
  lane: "benchmark-showcase",
  rewardAsset: "USDC",
  rewardAmount: 1,
  inputSchemaRef: "schema://jobs/coding-input"
};
const options = parseArgs(process.argv.slice(2));

function status(green) {
  return green ? "GREEN" : "RED";
}

function preflight(overrides = {}) {
  return {
    commit: CONTRACT.subject.acquisition.base_commit,
    classification: "HERMETIC",
    classificationReason: null,
    basePassed: true,
    attempts: [{ stdout: "", stderr: "" }],
    ...overrides
  };
}

function freeze() {
  return {
    valid: true,
    issues: [],
    evidence: {
      checks: [{
        id: CONTRACT.checks.hidden.id,
        kind: "hidden",
        expected: "fail",
        outcome: "fail"
      }]
    }
  };
}

function envelope(contract = CONTRACT) {
  const frozenContract = structuredClone(contract);
  return {
    schemaVersion: CODE_CHANGE_JOB_SCHEMA_VERSION,
    contractState: "frozen",
    contractDigest: hashFrozenVerificationContract(frozenContract),
    contractDigestAlgorithm: FROZEN_CONTRACT_DIGEST_ALGORITHM,
    contract: frozenContract,
    preflight: {
      result: "EXECUTABLE",
      materializationStatus: "HERMETIC",
      reports: [{
        checkId: "full-suite",
        checkKind: "regression",
        classification: "HERMETIC",
        baseOutcome: "pass"
      }]
    },
    freeze: {
      validated: true,
      baselineDifferentials: [{
        id: CONTRACT.checks.hidden.id,
        kind: "hidden",
        expected: "fail",
        outcome: "fail"
      }]
    }
  };
}

async function mutation(root, { file, anchor, replacement, id, importFile = file }) {
  const mutationRoot = join(root, id);
  await cp(resolve(REPO_ROOT, "witness/src"), resolve(mutationRoot, "witness/src"), { recursive: true });
  await cp(resolve(REPO_ROOT, "mcp-server/src/core"), resolve(mutationRoot, "mcp-server/src/core"), { recursive: true });
  const target = resolve(mutationRoot, file);
  const source = await readFile(target, "utf8");
  const anchorOccurrences = source.split(anchor).length - 1;
  const changed = anchorOccurrences === 1 ? source.replace(anchor, replacement) : source;
  const applied = anchorOccurrences === 1 && changed !== source && !changed.includes(anchor);
  await writeFile(target, changed);
  return {
    module: await import(`${pathToFileURL(resolve(mutationRoot, importFile)).href}?mutation=${id}`),
    mutation: { anchorOccurrences, applied }
  };
}

async function captureRefusal(action) {
  try {
    await action();
    return { accepted: true, reason: null };
  } catch (error) {
    return { accepted: false, reason: error.reason || error.code || error.message };
  }
}

// Keep mutants below the repository so package resolution reaches the checked-in
// workspace node_modules while every mutated module remains disposable.
const temporaryRoot = await mkdtemp(resolve(WITNESS_ROOT, ".code-change-drills-"));
try {
  const networkAnchor = "  if (report.classification === CLASSIFICATIONS.REQUIRES_NETWORK) {";
  const networkMutant = await mutation(temporaryRoot, {
    file: "witness/src/code-change-publication.mjs",
    importFile: "witness/src/code-change-publication.mjs",
    anchor: networkAnchor,
    replacement: "  if (false && report.classification === CLASSIFICATIONS.REQUIRES_NETWORK) { // MUTANT: named network refusal disabled",
    id: "network-refusal"
  });
  const networkDependencies = {
    runPreflight: async () => preflight({
      classification: "REQUIRES_NETWORK",
      classificationReason: "fetch failed",
      basePassed: false
    }),
    validateAtFreeze: async () => freeze()
  };
  const guardedNetwork = await captureRefusal(() => prepareCodeChangeJob(
    { contract: CONTRACT, job: JOB },
    {},
    networkDependencies
  ));
  const mutantNetwork = await captureRefusal(() => networkMutant.module.prepareCodeChangeJob(
    { contract: CONTRACT, job: JOB },
    {},
    networkDependencies
  ));
  const correctedNetwork = await captureRefusal(() => prepareCodeChangeJob(
    { contract: CONTRACT, job: JOB },
    {},
    { runPreflight: async () => preflight(), validateAtFreeze: async () => freeze() }
  ));

  const digestAnchor = "  if (reproducedDigest !== value.contractDigest) {";
  const digestMutant = await mutation(temporaryRoot, {
    file: "mcp-server/src/core/code-change-job.js",
    importFile: "mcp-server/src/core/code-change-job.js",
    anchor: digestAnchor,
    replacement: "  if (false && reproducedDigest !== value.contractDigest) { // MUTANT: frozen digest comparison disabled",
    id: "contract-digest"
  });
  const mutableEnvelope = envelope();
  mutableEnvelope.contract.candidate.maximum_changed_files += 1;
  const guardedMutation = await captureRefusal(() => normalizeCodeChangeDefinition(
    mutableEnvelope,
    { expectedJobId: CONTRACT.job.id }
  ));
  const mutantMutation = await captureRefusal(() => digestMutant.module.normalizeCodeChangeDefinition(
    mutableEnvelope,
    { expectedJobId: CONTRACT.job.id }
  ));
  const unfrozen = await captureRefusal(() => normalizeCodeChangeDefinition(
    { ...envelope(), contractState: "draft" },
    { expectedJobId: CONTRACT.job.id }
  ));
  const correctedDigest = await captureRefusal(() => normalizeCodeChangeDefinition(
    envelope(),
    { expectedJobId: CONTRACT.job.id }
  ));

  const schemaAnchor = "  [\"schema://jobs/patch-submission-output\", objectSchema({";
  const schemaMutant = await mutation(temporaryRoot, {
    file: "mcp-server/src/core/job-schema-registry.js",
    importFile: "mcp-server/src/core/job-schema-registry.js",
    anchor: schemaAnchor,
    replacement: "  [\"schema://jobs/patch-submission-output\", objectSchema(\n    { additionalProperties: true, // MUTANT: verification claims allowed",
    id: "patch-schema"
  });
  const submission = {
    patch: {
      sha256: "a".repeat(64),
      bytes: 42,
      locator: { kind: "https", url: "https://artifacts.example.test/candidate.patch" },
      format: "file"
    },
    baseCommit: CONTRACT.subject.acquisition.base_commit,
    submittingAgent: { wallet: "0x1234567890123456789012345678901234567890" }
  };
  const forbidden = await captureRefusal(() => validateStructuredSubmission(
    "schema://jobs/patch-submission-output",
    { ...submission, verdict: "PASS", receipt: { id: "invented" } }
  ));
  const mutantForbidden = await captureRefusal(() => schemaMutant.module.validateStructuredSubmission(
    "schema://jobs/patch-submission-output",
    { ...submission, verdict: "PASS", receipt: { id: "invented" } }
  ));
  const correctedSubmission = await captureRefusal(() => validateStructuredSubmission(
    "schema://jobs/patch-submission-output",
    submission
  ));

  const prepared = await prepareCodeChangeJob(
    { contract: CONTRACT, job: JOB },
    {},
    { runPreflight: async () => preflight(), validateAtFreeze: async () => freeze() }
  );
  const publicationAnchor = "      definition?.codeChange?.contractDigest !== prepared.contractDigest) {";
  const publicationMutant = await mutation(temporaryRoot, {
    file: "witness/src/code-change-publication.mjs",
    importFile: "witness/src/code-change-publication.mjs",
    anchor: publicationAnchor,
    replacement: "      false) { // MUTANT: board contract-digest readback disabled",
    id: "publication-digest"
  });
  const fetchFor = (definition) => async (_url, fetchOptions = {}) => new Response(
    JSON.stringify(fetchOptions.method === "POST" ? prepared.job : { jobs: [definition] }),
    { status: fetchOptions.method === "POST" ? 201 : 200 }
  );
  const changedDefinition = structuredClone(prepared.job);
  changedDefinition.codeChange.contractDigest = `0x${"0".repeat(64)}`;
  const guardedReadback = await captureRefusal(() => publishCodeChangeJob(
    prepared,
    { apiUrl: "https://testnet.api.example", token: "test" },
    { fetchImpl: fetchFor(changedDefinition) }
  ));
  const mutantReadback = await captureRefusal(() => publicationMutant.module.publishCodeChangeJob(
    prepared,
    { apiUrl: "https://testnet.api.example", token: "test" },
    { fetchImpl: fetchFor(changedDefinition) }
  ));
  const correctedReadback = await captureRefusal(() => publishCodeChangeJob(
    prepared,
    { apiUrl: "https://testnet.api.example", token: "test" },
    { fetchImpl: fetchFor(prepared.job) }
  ));

  const evidence = {
    schemaVersion: "averray.witness.code-change-drills/v1",
    drills: {
      preflight_requires_network: {
        mutation: networkMutant.mutation,
        green: {
          status: status(
            guardedNetwork.reason === CODE_CHANGE_CREATION_REASONS.PREFLIGHT_REQUIRES_NETWORK &&
            correctedNetwork.accepted
          ),
          refusedReason: guardedNetwork.reason,
          correctedAccepted: correctedNetwork.accepted
        },
        seenRed: {
          status: mutantNetwork.reason !== CODE_CHANGE_CREATION_REASONS.PREFLIGHT_REQUIRES_NETWORK ? "RED" : "GREEN",
          mutantReason: mutantNetwork.reason
        }
      },
      frozen_contract_digest: {
        mutation: digestMutant.mutation,
        green: {
          status: status(!guardedMutation.accepted && !unfrozen.accepted && correctedDigest.accepted),
          mutatedAccepted: guardedMutation.accepted,
          unfrozenAccepted: unfrozen.accepted,
          correctedAccepted: correctedDigest.accepted
        },
        seenRed: {
          status: mutantMutation.accepted ? "RED" : "GREEN",
          mutantAccepted: mutantMutation.accepted
        }
      },
      unverified_submission_schema: {
        mutation: schemaMutant.mutation,
        green: {
          status: status(!forbidden.accepted && correctedSubmission.accepted),
          verdictReceiptAccepted: forbidden.accepted,
          correctedAccepted: correctedSubmission.accepted
        },
        seenRed: {
          status: mutantForbidden.accepted ? "RED" : "GREEN",
          mutantAccepted: mutantForbidden.accepted
        }
      },
      published_contract_digest: {
        mutation: publicationMutant.mutation,
        green: {
          status: status(!guardedReadback.accepted && correctedReadback.accepted),
          mismatchedBoardAccepted: guardedReadback.accepted,
          matchingBoardAccepted: correctedReadback.accepted,
          contractDigest: prepared.contractDigest
        },
        seenRed: {
          status: mutantReadback.accepted ? "RED" : "GREEN",
          mutantAccepted: mutantReadback.accepted
        }
      }
    }
  };
  const mutations = Object.values(evidence.drills).map((drill) => drill.mutation);
  const passed = Object.values(evidence.drills).every((drill) =>
    drill.green.status === "GREEN" && drill.seenRed.status === "RED"
  ) && mutations.every((entry) => entry.anchorOccurrences === 1 && entry.applied === true);
  evidence.passed = passed;
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, json);
  }
  process.stdout.write(json);
  if (!passed) process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== "--out" || !argv[index + 1]) throw new Error(`${argv[index]} requires a value`);
    result.out = resolve(argv[index + 1]);
  }
  return result;
}
