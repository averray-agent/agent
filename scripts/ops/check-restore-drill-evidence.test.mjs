import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SCHEMA_VERSION, validateEvidence } from "./check-restore-drill-evidence.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-restore-drill-evidence.mjs"
);

function validEvidence(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    drillDate: "2026-05-22",
    completedAt: "2026-05-22T16:30:00.000Z",
    operator: {
      name: "Pascal",
      signature: "PK"
    },
    target: {
      type: "disposable_container",
      label: "local restore drill containers"
    },
    readiness: {
      checkedAt: "2026-05-22T16:00:00.000Z",
      backupDir: "/srv/agent-stack/backups",
      maxAgeHours: 26,
      overallStatus: "ok",
      components: [
        {
          name: "postgres",
          status: "ok",
          file: "/srv/agent-stack/backups/postgres/agent-20260522-010000.sql.gz",
          ageSeconds: 3600,
          message: "Newest backup is 1.0h old"
        },
        {
          name: "redis",
          status: "ok",
          file: "/srv/agent-stack/backups/redis/redis-20260522-010000.rdb.gz",
          ageSeconds: 3600,
          message: "Newest backup is 1.0h old"
        }
      ]
    },
    postgres: {
      backupFile: "agent-20260522-010000.sql.gz",
      restoreTarget: "drill-postgres",
      restoreExitCode: 0,
      rowCheck: {
        query: "select count(*) from submissions;",
        rowCount: 42
      }
    },
    redis: {
      backupFile: "redis-20260522-010000.rdb.gz",
      restoreTarget: "drill-redis",
      restoreExitCode: 0,
      dbSize: 13
    },
    cleanup: {
      postgresTargetRemoved: true,
      redisTargetRemoved: true
    },
    ...overrides
  };
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "restore-drill-evidence-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

test("validateEvidence accepts complete restore drill evidence", () => {
  const result = validateEvidence(validEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.postgresRowCount, 42);
  assert.equal(result.summary.redisDbSize, 13);
});

test("validateEvidence rejects stale readiness and production-looking targets", () => {
  const doc = validEvidence({
    completedAt: "2026-05-22",
    target: {
      type: "production",
      label: "production postgres"
    },
    readiness: {
      ...validEvidence().readiness,
      overallStatus: "not_ok",
      backupDir: "",
      components: [
        {
          name: "postgres",
          status: "stale",
          file: "/srv/agent-stack/backups/postgres/agent-20260520-010000.sql.gz",
          ageSeconds: 200000,
          message: "stale"
        }
      ]
    }
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("readiness.overallStatus must be ok"));
  assert.ok(result.errors.includes("completedAt must be an ISO-8601 date/time"));
  assert.ok(result.errors.includes("readiness.backupDir must be a non-empty string"));
  assert.ok(result.errors.includes("target.type must be disposable_container, disposable_vm, or local_throwaway"));
  assert.ok(result.errors.includes("target.label must not describe a production/live target"));
  assert.ok(result.errors.includes("readiness.components.redis is required"));
});

test("validateEvidence rejects mismatched readiness and restore files", () => {
  const doc = validEvidence({
    postgres: {
      ...validEvidence().postgres,
      backupFile: "different.sql.gz"
    }
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("postgres.backupFile must match the readiness postgres backup file"));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.operator, "Pascal");
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    redis: {
      ...validEvidence().redis,
      restoreExitCode: 1
    }
  }));
  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /redis\.restoreExitCode must be 0/u);
      return true;
    }
  );
});
