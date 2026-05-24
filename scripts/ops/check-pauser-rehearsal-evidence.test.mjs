import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EVIDENCE_KIND, SCHEMA_VERSION, validateEvidence } from "./check-pauser-rehearsal-evidence.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-pauser-rehearsal-evidence.mjs"
);

const OWNER = "0x1111111111111111111111111111111111111111";
const PAUSER = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const ARBITRATOR = "0x4444444444444444444444444444444444444444";
const DEPLOYER = "0x5555555555555555555555555555555555555555";
const TREASURY_POLICY = "0x6666666666666666666666666666666666666666";

function baseChecks(extraChecks = []) {
  return [
    "owner_matches_manifest",
    "pauser_matches_manifest",
    "pauser_is_nonzero",
    "pauser_not_owner",
    "pauser_not_service_operator",
    "pauser_not_owner_admin_if_owner_distinct",
    "pauser_can_call_setPaused_true",
    "pauser_cannot_call_setPauser",
    "pauser_cannot_call_setVerifier",
    "pauser_cannot_call_setServiceOperator",
    "pauser_cannot_call_transferOwnership",
    ...extraChecks
  ].map((name) => ({ name, ok: true, details: {} }));
}

function validEvidence(overrides = {}) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    profile: "testnet",
    generatedAt: "2026-05-24T10:00:00.000Z",
    mode: "read_only_capability_proof",
    manifestPath: "deployments/testnet.json",
    rpcUrl: "https://rpc.example.invalid",
    contracts: {
      treasuryPolicy: TREASURY_POLICY
    },
    manifest: {
      owner: OWNER,
      pauser: PAUSER,
      verifier: VERIFIER,
      arbitrator: ARBITRATOR,
      deployer: DEPLOYER
    },
    live: {
      owner: OWNER,
      pauser: PAUSER,
      paused: false
    },
    roleOverlap: {
      dedicated: true,
      overlaps: [],
      severity: "ok"
    },
    roleReads: {
      serviceOperator: false,
      verifier: false,
      arbitrator: false
    },
    simulation: [
      {
        name: "pauser_can_call_setPaused_true",
        expected: "success",
        actual: "success"
      }
    ],
    transactions: {},
    checks: baseChecks(),
    warnings: [
      {
        code: "live_rehearsal_not_run",
        severity: "warning",
        message: "Read-only capability proof passed, but the launch checklist still needs a live pause/unpause tx pair."
      }
    ],
    ok: true,
    launchGate: {
      controlPlanePauserReady: true,
      pauseUnpauseRehearsed: false,
      requiresLiveRehearsal: true
    }
  };

  return {
    ...doc,
    ...overrides
  };
}

function liveEvidence(overrides = {}) {
  return validEvidence({
    mode: "live_pause_unpause",
    checks: baseChecks([
      "live_pause_state_confirmed",
      "live_unpause_state_confirmed",
      "pauser_is_dedicated_role",
      "pauser_not_verifier",
      "pauser_not_arbitrator"
    ]),
    transactions: {
      pause: {
        hash: `0x${"a".repeat(64)}`,
        blockNumber: 12345,
        status: 1
      },
      unpause: {
        hash: `0x${"b".repeat(64)}`,
        blockNumber: 12346,
        status: 1
      }
    },
    warnings: [],
    launchGate: {
      controlPlanePauserReady: true,
      pauseUnpauseRehearsed: true,
      requiresLiveRehearsal: false
    },
    ...overrides
  });
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "pauser-rehearsal-evidence-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

test("validateEvidence accepts complete read-only pauser evidence", () => {
  const result = validateEvidence(validEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings[0], /live pause\/unpause was not rehearsed/u);
  assert.equal(result.summary.controlPlanePauserReady, true);
});

test("validateEvidence accepts live pause and unpause proof", () => {
  const result = validateEvidence(liveEvidence(), { requireLive: true, requireDedicatedPauser: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.pauseUnpauseRehearsed, true);
  assert.equal(result.summary.dedicatedPauser, true);
});

test("validateEvidence rejects read-only evidence when live proof is required", () => {
  const result = validateEvidence(validEvidence(), { requireLive: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("mode must be live_pause_unpause for live proof"));
  assert.ok(result.errors.includes("launchGate.pauseUnpauseRehearsed must be true for live proof"));
  assert.ok(result.errors.includes("transactions.pause must be an object"));
  assert.ok(result.errors.includes("transactions.unpause must be an object"));
});

test("validateEvidence rejects malformed evidence that claims live proof", () => {
  const result = validateEvidence(validEvidence({
    mode: "live_pause_unpause",
    warnings: [],
    launchGate: {
      controlPlanePauserReady: true,
      pauseUnpauseRehearsed: true,
      requiresLiveRehearsal: false
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("checks must include live_pause_state_confirmed"));
  assert.ok(result.errors.includes("transactions.pause must be an object"));
  assert.ok(result.errors.includes("transactions.unpause must be an object"));
});

test("validateEvidence rejects missing and failed required checks", () => {
  const result = validateEvidence(validEvidence({
    checks: baseChecks().filter((check) => check.name !== "pauser_cannot_call_setVerifier").map((check) =>
      check.name === "pauser_can_call_setPaused_true" ? { ...check, ok: false } : check
    )
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("checks[6].ok must be true"));
  assert.ok(result.errors.includes("checks.pauser_can_call_setPaused_true.ok must be true"));
  assert.ok(result.errors.includes("checks must include pauser_cannot_call_setVerifier"));
});

test("validateEvidence rejects role overlap when dedicated pauser proof is required", () => {
  const result = validateEvidence(validEvidence({
    roleOverlap: {
      dedicated: false,
      overlaps: ["verifier"],
      severity: "warning"
    }
  }), { requireDedicatedPauser: true });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("roleOverlap.dedicated must be true when --require-dedicated-pauser is used"));
  assert.ok(result.errors.includes("roleOverlap.overlaps must be empty when --require-dedicated-pauser is used"));
  assert.ok(result.errors.includes("checks must include pauser_is_dedicated_role"));
});

test("CLI exits zero and prints JSON for valid read-only evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.pauser, PAUSER);
  assert.equal(parsed.warnings.length, 1);
});

test("CLI exits non-zero for evidence that does not satisfy live proof", async () => {
  const file = await writeEvidenceFile(validEvidence());

  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file, "--require-live"]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /mode must be live_pause_unpause/u);
      assert.match(error.stderr, /transactions\.pause must be an object/u);
      return true;
    }
  );
});
