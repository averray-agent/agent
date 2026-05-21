import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDedicatedPauser, parseArgs } from "./run-pauser-rehearsal.mjs";

test("parseArgs supports live evidence options", () => {
  const options = parseArgs([
    "--profile",
    "testnet",
    "--out",
    "docs/evidence/pauser.json",
    "--live",
    "--require-dedicated-pauser"
  ]);

  assert.equal(options.profile, "testnet");
  assert.equal(options.out, "docs/evidence/pauser.json");
  assert.equal(options.live, true);
  assert.equal(options.requireDedicatedPauser, true);
});

test("dedicated pauser evaluator reports overlapping roles", () => {
  const result = evaluateDedicatedPauser({
    pauser: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    owner: "0x1f8c4da4aaac79916350f1fabf1221309591b6f9",
    deployer: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    verifier: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    arbitrator: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519"
  });

  assert.equal(result.dedicated, false);
  assert.equal(result.severity, "warning");
  assert.deepEqual(result.overlaps, ["deployer", "verifier", "arbitrator"]);
});

test("dedicated pauser evaluator treats owner overlap as an error", () => {
  const result = evaluateDedicatedPauser({
    pauser: "0x1111111111111111111111111111111111111111",
    owner: "0x1111111111111111111111111111111111111111"
  });

  assert.equal(result.dedicated, false);
  assert.equal(result.severity, "error");
  assert.deepEqual(result.overlaps, ["owner"]);
});
