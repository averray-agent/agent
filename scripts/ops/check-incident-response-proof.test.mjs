import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SCHEMA_VERSION, validateEvidence } from "./check-incident-response-proof.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-incident-response-proof.mjs"
);

function validEvidence(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    proofDate: "2026-05-28",
    completedAt: "2026-05-28T14:00:00.000Z",
    polkadotDocs: [
      "smart-contracts/explorers.md",
      "smart-contracts/for-eth-devs/accounts.md"
    ],
    target: {
      environment: "production",
      apiBaseUrl: "https://api.averray.com",
      chainEnv: "testnet",
      network: "polkadot-hub-testnet"
    },
    contacts: {
      primaryOnCall: "ops@averray.com",
      backupOnCall: "backup@averray.com",
      pauserOperator: "pauser@averray.com",
      externalEscalation: {
        status: "not_engaged_v1",
        internalFallbackDocumented: true
      }
    },
    severityDrills: {
      p1: {
        acknowledged: true,
        ackMinutes: 1,
        humanOwnerEngaged: true,
        pauseDecisionRecorded: true
      },
      p2: {
        acknowledged: true,
        ackMinutes: 10,
        mitigationOrRollbackMinutes: 40
      },
      p3: {
        sameDayTriage: true
      }
    },
    alertDelivery: {
      checkHostedStackAndAlertRan: true,
      deliberateFailureDelivered: true,
      greenAfterRestore: true,
      webhookSecretRedacted: true,
      channel: "ops-alerts",
      correlationId: "incident-proof-2026-05-28",
      receivedAt: "2026-05-28T13:45:00.000Z"
    },
    pauseFlow: {
      evidenceFile: "docs/evidence/pauser-rehearsal-testnet-2026-05-28.json",
      pauserEvidenceValidated: true,
      validationCommand: "node scripts/ops/check-pauser-rehearsal-evidence.mjs --file docs/evidence/pauser-rehearsal-testnet-2026-05-28.json --require-live --json",
      livePauseUnpauseRehearsed: true,
      pausedStateObserved: true,
      unpausedStateObserved: true,
      finalPaused: false,
      pauseTxHash: hash("a"),
      unpauseTxHash: hash("b"),
      explorerUrls: [
        `https://blockscout-testnet.polkadot.io/tx/${hash("a")}`,
        `https://assethub-paseo.subscan.io/extrinsic/${hash("b")}`
      ]
    },
    rollbackRehearsal: {
      backend: rollback("backend", "scripts/ops/redeploy-backend.sh"),
      indexer: rollback("indexer", "scripts/ops/redeploy-indexer.sh"),
      frontend: rollback("frontend", "scripts/ops/redeploy-frontend.sh", { envRerenderObserved: undefined })
    },
    escalation: {
      incidentChannel: "ops-incidents",
      primaryAck: true,
      backupAck: true,
      ownerSignerReachable: true,
      handoffRecordCreated: true,
      handoffRecord: "github-issue-123"
    },
    postIncidentRecord: {
      recordUri: "docs/evidence/incident-response-note-2026-05-28.md",
      containsTimeline: true,
      containsBlastRadius: true,
      containsRootCause: true,
      containsDetectionReview: true,
      containsPreventionChange: true,
      containsResumeCriteria: true,
      noSecrets: true
    },
    guardrails: {
      noPrivateKeys: true,
      noRawWebhooks: true,
      noJwt: true,
      noProviderApiKeys: true,
      productionChangesReverted: true,
      directFundsMovementClaimed: false,
      finalPaused: false
    },
    ...overrides
  };
}

function rollback(component, script, overrides = {}) {
  return {
    script,
    rollbackPathExercised: true,
    healthGateObserved: true,
    envRerenderObserved: component !== "frontend",
    correlationId: `rollback-${component}-2026-05-28`,
    completedAt: "2026-05-28T13:50:00.000Z",
    ...overrides
  };
}

function mainnetEvidence(overrides = {}) {
  return validEvidence({
    target: {
      environment: "production",
      apiBaseUrl: "https://api.averray.com",
      chainEnv: "mainnet",
      network: "polkadot-hub-mainnet"
    },
    pauseFlow: {
      ...validEvidence().pauseFlow,
      validationCommand: "node scripts/ops/check-pauser-rehearsal-evidence.mjs --file docs/evidence/pauser-rehearsal-mainnet-2026-05-28.json --require-live --require-dedicated-pauser --json",
      explorerUrls: [
        `https://blockscout.polkadot.io/tx/${hash("a")}`,
        `https://assethub-polkadot.subscan.io/extrinsic/${hash("b")}`
      ]
    },
    ...overrides
  });
}

function hash(prefix) {
  return `0x${prefix}${"0".repeat(64 - prefix.length)}`;
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "incident-response-proof-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

test("validateEvidence accepts a complete redacted incident-response proof", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-28T15:00:00.000Z"),
    maxCompletedAgeHours: 24
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.chainEnv, "testnet");
  assert.equal(result.summary.alertDelivered, true);
  assert.equal(result.summary.pauseRehearsed, true);
});

test("validateEvidence warns when launch freshness is not enforced", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-28T15:00:00.000Z")
  });

  assert.equal(result.ok, true);
  assert.match(result.warnings[0], /completedAt freshness was not enforced/u);
});

test("validateEvidence accepts mainnet proof only with the mainnet hardening flags", () => {
  const result = validateEvidence(mainnetEvidence(), {
    now: new Date("2026-05-28T15:00:00.000Z"),
    maxCompletedAgeHours: 24,
    requireMainnet: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.mainnetRequired, true);
});

test("validateEvidence rejects testnet evidence when mainnet proof is required", () => {
  const result = validateEvidence(validEvidence(), {
    requireMainnet: true
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("target.chainEnv must be mainnet when --require-mainnet is used"));
  assert.ok(result.errors.includes("target.network must be polkadot-hub-mainnet when --require-mainnet is used"));
  assert.ok(result.errors.includes("pauseFlow.validationCommand must include --require-dedicated-pauser when --require-mainnet is used"));
  assert.ok(result.errors.includes("pauseFlow.explorerUrls[0] must use a Polkadot Hub mainnet explorer host when --require-mainnet is used"));
});

test("validateEvidence rejects missing Polkadot docs and non-production target", () => {
  const result = validateEvidence(validEvidence({
    polkadotDocs: ["smart-contracts/explorers.md"],
    target: {
      environment: "staging",
      apiBaseUrl: "https://api.example.test",
      chainEnv: "local",
      network: "paseo"
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("polkadotDocs must include smart-contracts/for-eth-devs/accounts.md"));
  assert.ok(result.errors.includes("target.environment must be production"));
  assert.ok(result.errors.includes("target.apiBaseUrl must be the hosted production API base URL"));
  assert.ok(result.errors.includes("target.chainEnv must be testnet or mainnet"));
  assert.ok(result.errors.includes("target.network must be polkadot-hub-testnet or polkadot-hub-mainnet"));
});

test("validateEvidence rejects stale, future, and mismatched proof dates", () => {
  const stale = validateEvidence(validEvidence(), {
    now: new Date("2026-05-30T14:01:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes("completedAt must be within 24 hour(s)"));

  const future = validateEvidence(validEvidence({
    proofDate: "2026-05-28",
    completedAt: "2026-05-28T15:10:00.000Z"
  }), {
    now: new Date("2026-05-28T15:00:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(future.ok, false);
  assert.ok(future.errors.includes("completedAt must not be in the future"));

  const mismatched = validateEvidence(validEvidence({
    proofDate: "2026-05-27"
  }));
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.errors.includes("proofDate must match completedAt UTC date"));
});

test("validateEvidence rejects incomplete severity and alert drills", () => {
  const result = validateEvidence(validEvidence({
    severityDrills: {
      ...validEvidence().severityDrills,
      p1: {
        acknowledged: false,
        ackMinutes: 6,
        humanOwnerEngaged: false,
        pauseDecisionRecorded: false
      },
      p2: {
        acknowledged: true,
        ackMinutes: 16,
        mitigationOrRollbackMinutes: 61
      }
    },
    alertDelivery: {
      ...validEvidence().alertDelivery,
      deliberateFailureDelivered: false,
      greenAfterRestore: false,
      webhookSecretRedacted: false
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("severityDrills.p1.acknowledged must be true"));
  assert.ok(result.errors.includes("severityDrills.p1.ackMinutes must be <= 5"));
  assert.ok(result.errors.includes("severityDrills.p2.ackMinutes must be <= 15"));
  assert.ok(result.errors.includes("severityDrills.p2.mitigationOrRollbackMinutes must be <= 60"));
  assert.ok(result.errors.includes("alertDelivery.deliberateFailureDelivered must be true"));
  assert.ok(result.errors.includes("alertDelivery.greenAfterRestore must be true"));
  assert.ok(result.errors.includes("alertDelivery.webhookSecretRedacted must be true"));
});

test("validateEvidence rejects pause proof that leaves the system paused", () => {
  const result = validateEvidence(validEvidence({
    pauseFlow: {
      ...validEvidence().pauseFlow,
      validationCommand: "node scripts/ops/other.mjs",
      pauserEvidenceValidated: false,
      livePauseUnpauseRehearsed: false,
      finalPaused: true,
      explorerUrls: [`https://example.test/tx/${hash("a")}`]
    },
    guardrails: {
      ...validEvidence().guardrails,
      finalPaused: true
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("pauseFlow.pauserEvidenceValidated must be true"));
  assert.ok(result.errors.includes("pauseFlow.validationCommand must use check-pauser-rehearsal-evidence.mjs"));
  assert.ok(result.errors.includes("pauseFlow.livePauseUnpauseRehearsed must be true"));
  assert.ok(result.errors.includes("pauseFlow.finalPaused must be false"));
  assert.ok(result.errors.includes("pauseFlow.explorerUrls must include pause and unpause explorer URLs"));
  assert.ok(result.errors.includes("pauseFlow.explorerUrls[0] must use a Polkadot Hub or Hub TestNet explorer host"));
  assert.ok(result.errors.includes("guardrails.finalPaused must be false"));
});

test("validateEvidence rejects rollback evidence that misses required components", () => {
  const result = validateEvidence(validEvidence({
    rollbackRehearsal: {
      backend: {
        ...rollback("backend", "scripts/ops/redeploy-backend.sh"),
        rollbackPathExercised: false,
        envRerenderObserved: false
      },
      indexer: {
        ...rollback("indexer", "scripts/ops/wrong.sh"),
        healthGateObserved: false
      }
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("rollbackRehearsal.backend.rollbackPathExercised must be true"));
  assert.ok(result.errors.includes("rollbackRehearsal.backend.envRerenderObserved must be true"));
  assert.ok(result.errors.includes("rollbackRehearsal.indexer.script must be scripts/ops/redeploy-indexer.sh"));
  assert.ok(result.errors.includes("rollbackRehearsal.indexer.healthGateObserved must be true"));
  assert.ok(result.errors.includes("rollbackRehearsal.frontend must be an object"));
});

test("validateEvidence rejects incomplete escalation and post-incident records", () => {
  const result = validateEvidence(validEvidence({
    escalation: {
      ...validEvidence().escalation,
      backupAck: false,
      ownerSignerReachable: false
    },
    postIncidentRecord: {
      ...validEvidence().postIncidentRecord,
      containsRootCause: false,
      containsResumeCriteria: false,
      noSecrets: false
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("escalation.backupAck must be true"));
  assert.ok(result.errors.includes("escalation.ownerSignerReachable must be true"));
  assert.ok(result.errors.includes("postIncidentRecord.containsRootCause must be true"));
  assert.ok(result.errors.includes("postIncidentRecord.containsResumeCriteria must be true"));
  assert.ok(result.errors.includes("postIncidentRecord.noSecrets must be true"));
});

test("validateEvidence allows tx hashes and explorer URLs but rejects raw secrets", () => {
  const ok = validateEvidence(validEvidence());
  assert.equal(ok.ok, true);

  const result = validateEvidence(validEvidence({
    operatorNotes: `raw secret-looking value ${hash("c")}`,
    alertDelivery: {
      ...validEvidence().alertDelivery,
      webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX"
    },
    guardrails: {
      ...validEvidence().guardrails,
      noJwt: false
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("evidence.operatorNotes appears to contain a secret value; store raw secrets outside this evidence file"));
  assert.ok(result.errors.includes("evidence.alertDelivery.webhookUrl appears to contain a secret value; store raw secrets outside this evidence file"));
  assert.ok(result.errors.includes("guardrails.noJwt must be true"));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.chainEnv, "testnet");
});

test("CLI accepts fresh mainnet evidence with hardening flags", async () => {
  const file = await writeEvidenceFile(mainnetEvidence({
    proofDate: new Date().toISOString().slice(0, 10),
    completedAt: new Date().toISOString()
  }));
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--file",
    file,
    "--max-completed-age-hours",
    "1",
    "--require-mainnet",
    "--json"
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.mainnetRequired, true);
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    guardrails: {
      ...validEvidence().guardrails,
      noProviderApiKeys: false
    }
  }));

  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /guardrails\.noProviderApiKeys must be true/u);
      return true;
    }
  );
});
