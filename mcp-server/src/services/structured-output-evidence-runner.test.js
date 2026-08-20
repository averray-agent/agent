import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import {
  normalizeWhitespace,
  StructuredOutputEvidenceRunner
} from "./structured-output-evidence-runner.js";
import {
  STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF,
  VERIFY_PROFILE_PRICE,
  VerificationProfileRegistry
} from "./verification-profile-registry.js";
import { VerificationRunService } from "./verification-run-service.js";
import { WitnessRunnerService } from "./witness-runner-service.js";

const FIXTURE_URL = new URL(
  "./__fixtures__/structured-output-evidence-v1-known-good.json",
  import.meta.url
);
const SUCCESS_STATEMENT = "The output document parsed as JSON, validated against the declared schema, and every cited quote appears verbatim (whitespace-normalized) in its referenced source artifact during one bounded check. Verbatim presence is not an assessment that the sources semantically support the claims, and this is not a certification.";

const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
const registry = new VerificationProfileRegistry();
const profile = registry.get("structured-output-evidence-v1", 1);

test("profile 3 is published at the shared price with the pinned contains-all contract", () => {
  assert.equal(profile.ref, STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF);
  assert.equal(profile.status, "published");
  assert.equal(profile.handler, "deterministic");
  assert.deepEqual(profile.price, VERIFY_PROFILE_PRICE);
  assert.equal(profile.successCriteria.statement, SUCCESS_STATEMENT);
  assert.deepEqual(profile.successCriteria.requiredEvidence, fixture.expected.evidenceOutputs);
  assert.deepEqual(profile.verifierConfig.expectedOutputs, fixture.expected.evidenceOutputs);
  assert.equal(profile.verifierConfig.matchMode, "contains_all");
  assert.deepEqual(profile.verifierConfig.citationContract, {
    pointerSyntax: "RFC 6901",
    defaultPointer: "/citations",
    array: "non_empty",
    entry: { source: "zero_based_source_index", quote: "string_1_to_2048_characters" }
  });
  assert.deepEqual(profile.verifierConfig.quoteNormalization, {
    whitespace: "trim_then_collapse_runs_to_single_ascii_space",
    caseFolding: false,
    fuzzyMatching: false
  });
  assert.equal(profile.limits.schemaDepth, 32);
  assert.equal(profile.limits.outputSizeBytes, 1_048_576);
  assert.equal(profile.limits.schemaSizeBytes, 262_144);
  assert.equal(profile.limits.sourceSizeBytes, 2_097_152);
});

test("known-good replay has two sources, at least three citations, and all five evidence outputs", async () => {
  const execution = await replayFixture();
  assert.equal(fixture.request.target.sources.length, 2);
  assert.ok(JSON.parse(fixture.artifacts.output).citations.length >= 3);
  assert.equal(execution.status, "decidable");
  assert.deepEqual(
    execution.report.checks.map(({ name, verdict }) => [name, verdict]),
    [
      ["output-integrity", "pass"],
      ["schema-valid", "pass"],
      ["schema-conformance", "pass"],
      ["citation-resolution", "pass"],
      ["quote-support", "pass"]
    ]
  );
  assert.deepEqual(execution.evidence.split(" "), fixture.expected.evidenceOutputs);
});

test("red-then-green: altered quote word fails quote-support and the pinned replay passes", async () => {
  const redFixture = structuredClone(fixture);
  const output = JSON.parse(redFixture.artifacts.output);
  output.citations[1].quote = "Each run costs six USDC.";
  redFixture.artifacts.output = JSON.stringify(output);
  repin(redFixture.request.target.output, redFixture.artifacts.output);

  assert.equal(check(await replayFixture(redFixture), "quote-support").verdict, "fail");
  assert.equal(check(await replayFixture(), "quote-support").verdict, "pass");
});

test("red-then-green: removed required property fails schema-conformance and the pinned replay passes", async () => {
  const redFixture = structuredClone(fixture);
  const output = JSON.parse(redFixture.artifacts.output);
  delete output.summary;
  redFixture.artifacts.output = JSON.stringify(output);
  repin(redFixture.request.target.output, redFixture.artifacts.output);

  assert.equal(check(await replayFixture(redFixture), "schema-conformance").verdict, "fail");
  assert.equal(check(await replayFixture(), "schema-conformance").verdict, "pass");
});

test("red-then-green: emptied citations fails citation-resolution and the pinned replay passes", async () => {
  const redFixture = structuredClone(fixture);
  const output = JSON.parse(redFixture.artifacts.output);
  output.citations = [];
  redFixture.artifacts.output = JSON.stringify(output);
  repin(redFixture.request.target.output, redFixture.artifacts.output);

  const red = await replayFixture(redFixture);
  assert.equal(check(red, "schema-conformance").verdict, "pass");
  assert.deepEqual(
    pick(check(red, "citation-resolution"), ["verdict", "reason"]),
    { verdict: "fail", reason: "citations_absent_or_empty" }
  );
  assert.equal(check(await replayFixture(), "citation-resolution").verdict, "pass");
});

test("red-then-green: changed source bytes without sha is inconclusive, never captured, then pinned replay passes", async () => {
  const redFixture = structuredClone(fixture);
  redFixture.artifacts.sources[0] += "changed without updating the declared digest\n";
  const redRunner = fixtureRunner(redFixture);
  const red = await redRunner.run(runInput(redFixture));
  assert.equal(red.status, "inconclusive");
  assert.equal(red.reason, "ambiguous_evidence");

  const calls = { capture: 0, release: 0 };
  const stateStore = new MemoryStateStore();
  const runService = new VerificationRunService({
    stateStore,
    profileRegistry: registry,
    randomUUIDImpl: () => "structured-hash-mismatch",
    paymentGate: {
      async authorize() {
        return {
          id: "structured-payment-authorization",
          customer: "0x1111111111111111111111111111111111111111",
          amountRaw: VERIFY_PROFILE_PRICE.amountRaw,
          asset: VERIFY_PROFILE_PRICE.asset,
          network: VERIFY_PROFILE_PRICE.network
        };
      },
      async capture() { calls.capture += 1; },
      async release() { calls.release += 1; }
    }
  });
  const queued = await runService.createRun({
    ...redFixture.request,
    paymentProof: "structured-hash-mismatch-proof"
  });
  const witness = new WitnessRunnerService({
    stateStore,
    profileRegistry: registry,
    acceptedProfileRefs: [STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF],
    runnersByProfileRef: new Map([[STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF, redRunner]]),
    owner: "structured-output-test-runner"
  });
  await witness.runOnce();
  await runService.finalizeAvailableRuns();
  const completed = await runService.getRun(queued.runId);
  assert.equal(completed.verdict.outcome, "inconclusive");
  assert.equal(completed.billing.status, "not_billed");
  assert.equal(calls.capture, 0, "an in-runner hash mismatch must never attempt capture");
  assert.equal(calls.release, 1);

  assert.equal((await replayFixture()).status, "decidable");
});

test("whitespace-normalization edge: newline-wrapped quote matches spaces without case folding", async () => {
  assert.equal(
    normalizeWhitespace("  Hashes are checked\ninside   the sealed runner.  "),
    "Hashes are checked inside the sealed runner."
  );
  const output = JSON.parse(fixture.artifacts.output);
  assert.match(output.citations[2].quote, /\n/u);
  assert.equal(check(await replayFixture(), "quote-support").verdict, "pass");

  const redFixture = structuredClone(fixture);
  const changedCase = JSON.parse(redFixture.artifacts.output);
  changedCase.citations[2].quote = changedCase.citations[2].quote.replace("Hashes", "hashes");
  redFixture.artifacts.output = JSON.stringify(changedCase);
  repin(redFixture.request.target.output, redFixture.artifacts.output);
  assert.equal(check(await replayFixture(redFixture), "quote-support").verdict, "fail");
});

async function replayFixture(candidate = fixture) {
  return fixtureRunner(candidate).run(runInput(candidate));
}

function fixtureRunner(candidate) {
  const contentByUrl = fixtureContentByUrl(candidate);
  return new StructuredOutputEvidenceRunner({
    materializeArtifactImpl: async (artifact, destination) => {
      const content = contentByUrl.get(artifact.locator.url);
      if (content === undefined) throw new Error(`Fixture omitted ${artifact.locator.url}.`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
      return { path: destination };
    }
  });
}

function fixtureContentByUrl(candidate) {
  return new Map([
    [candidate.request.target.output.locator.url, candidate.artifacts.output],
    [candidate.request.target.schema.locator.url, candidate.artifacts.schema],
    ...candidate.request.target.sources.map((source, index) => [
      source.locator.url,
      candidate.artifacts.sources[index]
    ])
  ]);
}

function runInput(candidate) {
  return {
    profile,
    runId: "structured-output-fixture-replay",
    target: candidate.request.target,
    inputs: candidate.request.inputs
  };
}

function repin(artifact, content) {
  artifact.bytes = Buffer.byteLength(content);
  artifact.sha256 = createHash("sha256").update(content).digest("hex");
}

function check(execution, name) {
  return execution.report.checks.find((candidate) => candidate.name === name);
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
