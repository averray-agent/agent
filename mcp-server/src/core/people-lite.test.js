import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AVERRAY_PERSONHOOD_CONTEXT,
  PEOPLE_LITE_COPY,
  PEOPLE_LITE_FIXTURE_AT,
  PEOPLE_LITE_FIXTURE_WALLETS,
  PEOPLE_LITE_FIXTURES,
  decodePersonhoodStatusResult,
  displayNameFromUsernames,
  encodePersonhoodStatusCall,
  projectPeopleLite
} from "./people-lite.js";

const FORBIDDEN = [/unique human/iu, /sybil-proof/iu];

test("pinned fixtures project none, lite, and full-track with one snapshot", () => {
  const reads = ["none", "lite", "full"].map((key) => {
    const wallet = PEOPLE_LITE_FIXTURE_WALLETS[key];
    return projectPeopleLite({
      wallet,
      at: PEOPLE_LITE_FIXTURE_AT,
      snapshot: PEOPLE_LITE_FIXTURES[wallet]
    });
  });

  assert.deepEqual(reads.map((read) => read.tier), ["none", "lite", "full"]);
  assert.deepEqual(reads.map((read) => read.displayName), [null, "cedar.07", "cedar.dot"]);
  assert.deepEqual(reads.map((read) => read.detail.sdkTag), ["NotEnrolled", "Lite", "Member"]);
  for (const read of reads) {
    assert.equal(read.available, true);
    assert.deepEqual(read.at, {
      blockHash: PEOPLE_LITE_FIXTURE_AT.blockHash,
      blockNumber: PEOPLE_LITE_FIXTURE_AT.blockNumber,
      chain: "fixture:paseo-individuality",
      chainId: null
    });
    assert.equal(read.detail.gatesClaims, false);
  }
  assert.equal(reads[0].line.pill, null);
  assert.equal(reads[1].line.pill, "lite");
  assert.equal(reads[1].line.text, "cedar.07");
  assert.match(reads[1].line.tooltip, /governance-authorized attestation/u);
  assert.match(reads[1].line.tooltip, /hard sybil resistance/u);
  assert.equal(reads[2].line.pill, "full");
  assert.equal(reads[2].line.text, "cedar.dot");
});

test("full-track tags stay full and keep the SDK tag, and Suspended keeps its label with none privileges", () => {
  const cases = [
    ["0x0000000000000000000000000000000000000a44", "Candidate", "full", "full", "birch.dot"],
    ["0x0000000000000000000000000000000000000a55", "MembershipReady", "full", "full", "alder.11"],
    ["0x0000000000000000000000000000000000000a66", "Caution", "full", "full", "dusk.dot"],
    ["0x0000000000000000000000000000000000000a77", "Suspended", "none", "suspended", "elm.04"]
  ];
  for (const [wallet, sdkTag, tier, label, displayName] of cases) {
    const read = projectPeopleLite({
      wallet,
      at: PEOPLE_LITE_FIXTURE_AT,
      snapshot: PEOPLE_LITE_FIXTURES[wallet]
    });
    assert.equal(read.detail.sdkTag, sdkTag);
    assert.equal(read.tier, tier);
    assert.equal(read.detail.privileges, tier === "full" ? "full" : "none");
    assert.equal(read.detail.label, label);
    assert.equal(read.displayName, displayName);
    assert.equal(read.at.blockHash, PEOPLE_LITE_FIXTURE_AT.blockHash);
  }
  const suspended = projectPeopleLite({
    wallet: "0x0000000000000000000000000000000000000a77",
    at: PEOPLE_LITE_FIXTURE_AT,
    snapshot: PEOPLE_LITE_FIXTURES["0x0000000000000000000000000000000000000a77"]
  });
  assert.equal(suspended.line.pill, "suspended");
  assert.match(suspended.line.tooltip, /Privileges are treated as none/u);
});

test("display name prefers a claimed .dot over the lite username", () => {
  assert.equal(displayNameFromUsernames({
    fullUsername: "Cedar.dot",
    liteUsername: "cedar.07"
  }), "cedar.dot");
  assert.equal(displayNameFromUsernames({
    fullUsername: "not a name",
    liteUsername: "cedar.07"
  }), "cedar.07");
  assert.equal(displayNameFromUsernames({
    fullUsername: null,
    liteUsername: "cedar.00"
  }), null);
  assert.equal(displayNameFromUsernames({}), null);
});

test("hub precompile words map to none, lite, and full without inventing a full-track tag", () => {
  const wallet = "0x0000000000000000000000000000000000000001";
  const at = {
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 16,
    chain: "polkadot-hub",
    chainId: 420420419
  };
  const encoded = [0, 1, 2].map((status) => {
    const word = status.toString(16).padStart(64, "0");
    const alias = status === 0 ? "0".repeat(64) : "22".repeat(32);
    return `0x${word}${alias}`;
  });
  const reads = encoded.map((data) => {
    const decoded = decodePersonhoodStatusResult(data);
    return projectPeopleLite({
      wallet,
      at,
      snapshot: { kind: "precompile", status: decoded.status, contextAlias: decoded.contextAlias }
    });
  });
  assert.deepEqual(reads.map((read) => read.tier), ["none", "lite", "full"]);
  assert.deepEqual(reads.map((read) => read.displayName), [null, null, null]);
  assert.deepEqual(reads.map((read) => read.detail.sdkTag), [null, "Lite", null]);
  assert.equal(reads[2].detail.precompileStatus, 2);
  assert.match(reads[2].detail.note, /does not distinguish Candidate/u);
  assert.equal(reads[0].line.pill, null);
  assert.equal(reads[1].line.pill, "lite");
  assert.equal(decodePersonhoodStatusResult("0x"), null);
  assert.equal(decodePersonhoodStatusResult(`0x${"00"}`), null);
});

test("personhoodStatus calldata addresses the Revive precompile context", () => {
  const data = encodePersonhoodStatusCall("0x0000000000000000000000000000000000000001");
  assert.equal(data.slice(0, 10), "0x886af133");
  assert.equal(data.slice(10, 74), "0".repeat(24) + "0".repeat(39) + "1");
  assert.equal(`0x${data.slice(-64)}`, AVERRAY_PERSONHOOD_CONTEXT);
});

test("a read without a pinned block is refused", () => {
  assert.throws(() => projectPeopleLite({
    wallet: PEOPLE_LITE_FIXTURE_WALLETS.lite,
    at: null,
    snapshot: PEOPLE_LITE_FIXTURES[PEOPLE_LITE_FIXTURE_WALLETS.lite]
  }), /pinned block/u);
});

test("public copy does not claim unique-human or sybil-proof, and claim paths do not grow a personhood gate", async () => {
  for (const text of Object.values(PEOPLE_LITE_COPY)) {
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
  }
  const files = [
    new URL("./people-lite.js", import.meta.url),
    new URL("./job-execution-service.js", import.meta.url),
    new URL("./job-catalog-service.js", import.meta.url),
    new URL("./designated-claimants.js", import.meta.url),
    new URL("../../../marketing/public/agent.js", import.meta.url),
    new URL("../../../app/components/agents/PersonhoodPill.tsx", import.meta.url),
    new URL("../../../app/lib/agents/personhood-line.js", import.meta.url)
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(source, pattern, `${file.pathname} matches ${pattern}`);
    }
  }
  const jobs = await readFile(new URL("./job-execution-service.js", import.meta.url), "utf8");
  assert.doesNotMatch(jobs, /minPersonhood|people-lite|personhoodStatus/u);
});
