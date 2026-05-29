import test from "node:test";
import assert from "node:assert/strict";

import {
  TX_HASH_PATTERN,
  isTxHash,
  classifyChainReference,
  isLinkableChainReference,
  chainReferenceTitle,
} from "./chain-reference.js";

const TX = "0x" + "a".repeat(64);
const JOB = "0x46519cdd46ce82dccff06907c750c625c8f3fa2537ec855cfe02966586c593aa";

test("isTxHash accepts only the 0x + 64 hex shape", () => {
  assert.equal(isTxHash(TX), true);
  assert.equal(isTxHash(TX.toUpperCase().replace("0X", "0x")), true);
  assert.equal(isTxHash(`  ${TX}  `), true, "trims surrounding whitespace");
  assert.equal(isTxHash("0x" + "a".repeat(63)), false, "too short");
  assert.equal(isTxHash("0x" + "a".repeat(65)), false, "too long");
  assert.equal(isTxHash("0xZZZ"), false, "non-hex");
  assert.equal(isTxHash("a".repeat(64)), false, "missing 0x prefix");
  assert.equal(isTxHash(undefined), false);
  assert.equal(isTxHash(123), false);
});

test("classifyChainReference treats a genuine txHash field as a transaction", () => {
  assert.deepEqual(classifyChainReference({ txHash: TX }), {
    kind: "tx",
    value: TX,
  });
});

test("classifyChainReference NEVER promotes a chainJobId to a transaction, even though it is the same shape", () => {
  // This is the truth-boundary guarantee: a chainJobId is bytes32 and matches
  // TX_HASH_PATTERN, but arriving via `jobId` it must stay an escrow job id.
  assert.equal(TX_HASH_PATTERN.test(JOB), true, "fixture is tx-hash shaped");
  assert.deepEqual(classifyChainReference({ jobId: JOB }), {
    kind: "job",
    value: JOB,
  });
});

test("classifyChainReference prefers a valid tx over a job-id fallback", () => {
  assert.deepEqual(classifyChainReference({ txHash: TX, jobId: JOB }), {
    kind: "tx",
    value: TX,
  });
});

test("classifyChainReference falls back to the job id when txHash is not a real hash", () => {
  assert.deepEqual(classifyChainReference({ txHash: "pending", jobId: JOB }), {
    kind: "job",
    value: JOB,
  });
});

test("classifyChainReference returns 'none' when there is nothing to show", () => {
  assert.deepEqual(classifyChainReference({}), { kind: "none", value: "" });
  assert.deepEqual(classifyChainReference(), { kind: "none", value: "" });
  assert.deepEqual(classifyChainReference({ jobId: "   " }), {
    kind: "none",
    value: "",
  });
});

test("isLinkableChainReference only ever links a genuine transaction", () => {
  assert.equal(isLinkableChainReference({ kind: "tx", value: TX }), true);
  assert.equal(isLinkableChainReference({ kind: "job", value: JOB }), false);
  assert.equal(isLinkableChainReference({ kind: "none", value: "" }), false);
});

test("chainReferenceTitle never calls an escrow job a transaction", () => {
  assert.match(chainReferenceTitle({ kind: "tx", value: TX }), /transaction/u);
  const jobTitle = chainReferenceTitle({ kind: "job", value: JOB });
  assert.match(jobTitle, /Escrow job id/u);
  assert.match(jobTitle, /not an on-chain transaction/u);
  assert.match(chainReferenceTitle({ kind: "none", value: "" }), /No on-chain reference/u);
});
