import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEvidence,
  parseArgs,
  parseIntegerStdout,
  selectBackupCopies
} from "./run-restore-drill-from-backups.mjs";

function readiness() {
  return {
    checkedAt: "2026-05-27T18:53:28Z",
    backupDir: "/srv/agent-stack/backups",
    maxAgeHours: 26,
    overallStatus: "ok",
    components: [
      {
        name: "postgres",
        status: "ok",
        file: "/srv/agent-stack/backups/postgres/agent-20260527-205325.sql.gz",
        ageSeconds: 3,
        message: "Newest backup is 0.0h old"
      },
      {
        name: "redis",
        status: "ok",
        file: "/srv/agent-stack/backups/redis/redis-20260527-205325.rdb.gz",
        ageSeconds: 2,
        message: "Newest backup is 0.0h old"
      }
    ]
  };
}

test("parseArgs accepts restore drill inputs", () => {
  assert.deepEqual(parseArgs([
    "--readiness",
    "readiness.json",
    "--backup-dir",
    "backups",
    "--out",
    "restore.json",
    "--operator-name",
    "Hosted proof",
    "--operator-signature",
    "gh-1"
  ]), {
    readiness: "readiness.json",
    backupDir: "backups",
    out: "restore.json",
    operatorName: "Hosted proof",
    operatorSignature: "gh-1"
  });
});

test("selectBackupCopies resolves selected backup basenames under local backup dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "restore-drill-backups-"));
  await mkdir(join(root, "postgres"));
  await mkdir(join(root, "redis"));
  await writeFile(join(root, "postgres", "agent-20260527-205325.sql.gz"), "pg");
  await writeFile(join(root, "redis", "redis-20260527-205325.rdb.gz"), "redis");

  const selected = await selectBackupCopies(readiness(), root);

  assert.equal(selected.postgres.basename, "agent-20260527-205325.sql.gz");
  assert.equal(selected.redis.basename, "redis-20260527-205325.rdb.gz");
  assert.match(selected.postgres.localFile, /postgres\/agent-20260527-205325\.sql\.gz$/u);
  assert.match(selected.redis.localFile, /redis\/redis-20260527-205325\.rdb\.gz$/u);
});

test("selectBackupCopies rejects non-ok readiness before any restore", async () => {
  await assert.rejects(
    () => selectBackupCopies({ ...readiness(), overallStatus: "not_ok" }, "/tmp/nope"),
    /readiness\.overallStatus must be ok/u
  );
});

test("parseIntegerStdout accepts non-negative integer command output", () => {
  assert.equal(parseIntegerStdout("42\n", "rows"), 42);
  assert.throws(() => parseIntegerStdout("nope", "rows"), /rows did not return/u);
});

test("buildEvidence preserves readiness and selected backup filenames", () => {
  const selected = {
    postgres: { basename: "agent-20260527-205325.sql.gz" },
    redis: { basename: "redis-20260527-205325.rdb.gz" }
  };
  const evidence = buildEvidence({
    readiness: readiness(),
    selected,
    postgres: {
      restoreTarget: "drill-postgres-1",
      restoreExitCode: 0,
      rowCheck: {
        query: "select 1;",
        rowCount: 1
      }
    },
    redis: {
      restoreTarget: "drill-redis-1",
      restoreExitCode: 0,
      dbSize: 2
    },
    operatorName: "GitHub Actions",
    operatorSignature: "gh-123",
    completedAt: "2026-05-27T19:00:00.000Z"
  });

  assert.equal(evidence.schemaVersion, "restore-drill-evidence-v1");
  assert.equal(evidence.drillDate, "2026-05-27");
  assert.equal(evidence.postgres.backupFile, "agent-20260527-205325.sql.gz");
  assert.equal(evidence.redis.backupFile, "redis-20260527-205325.rdb.gz");
  assert.equal(evidence.target.type, "disposable_container");
});
