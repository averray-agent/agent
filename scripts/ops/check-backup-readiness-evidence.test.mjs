import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validateEvidence } from "./check-backup-readiness-evidence.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-backup-readiness-evidence.mjs"
);

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function validEvidence(overrides = {}) {
  return {
    checkedAt: isoHoursAgo(1),
    backupDir: "/srv/agent-stack/backups",
    maxAgeHours: 26,
    overallStatus: "ok",
    components: [
      {
        name: "postgres",
        status: "ok",
        file: "/srv/agent-stack/backups/postgres/agent-20260524-010000.sql.gz",
        ageSeconds: 3600,
        message: "Newest backup is 1.0h old"
      },
      {
        name: "redis",
        status: "ok",
        file: "/srv/agent-stack/backups/redis/redis-20260524-010000.rdb.gz",
        ageSeconds: 7200,
        message: "Newest backup is 2.0h old"
      }
    ],
    ...overrides
  };
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "backup-readiness-evidence-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

test("validateEvidence accepts complete backup readiness evidence", () => {
  const result = validateEvidence(validEvidence(), { maxCheckedAgeHours: 6 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.postgresFile, "/srv/agent-stack/backups/postgres/agent-20260524-010000.sql.gz");
  assert.equal(result.summary.redisAgeSeconds, 7200);
});

test("validateEvidence warns when evidence freshness is not enforced", () => {
  const result = validateEvidence(validEvidence());

  assert.equal(result.ok, true);
  assert.match(result.warnings[0], /checkedAt freshness was not enforced/u);
});

test("validateEvidence rejects stale or failed component evidence", () => {
  const result = validateEvidence(validEvidence({
    overallStatus: "not_ok",
    components: [
      {
        name: "postgres",
        status: "stale",
        file: "/srv/agent-stack/backups/postgres/agent-20260520-010000.sql.gz",
        ageSeconds: 100000,
        message: "stale"
      },
      {
        name: "redis",
        status: "ok",
        file: "/srv/agent-stack/backups/redis/redis-20260524-010000.dump",
        ageSeconds: 3600,
        message: "ok"
      }
    ]
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("overallStatus must be ok"));
  assert.ok(result.errors.includes("components.postgres.status must be ok"));
  assert.ok(result.errors.includes("components.postgres.ageSeconds must be <= maxAgeHours * 3600"));
  assert.ok(result.errors.includes("components.redis.file must end with .rdb.gz"));
});

test("validateEvidence rejects missing and duplicate components", () => {
  const result = validateEvidence(validEvidence({
    components: [
      {
        name: "postgres",
        status: "ok",
        file: "/srv/agent-stack/backups/postgres/agent-20260524-010000.sql.gz",
        ageSeconds: 3600,
        message: "ok"
      },
      {
        name: "postgres",
        status: "ok",
        file: "/srv/agent-stack/backups/postgres/agent-20260524-020000.sql.gz",
        ageSeconds: 1800,
        message: "ok"
      }
    ]
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("components must not contain duplicate postgres"));
  assert.ok(result.errors.includes("components.redis must be an object"));
  assert.ok(result.errors.includes("components.redis.status must be ok"));
});

test("validateEvidence rejects stale saved evidence when max checked age is set", () => {
  const result = validateEvidence(validEvidence({
    checkedAt: isoHoursAgo(30)
  }), { maxCheckedAgeHours: 6 });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("checkedAt must be within 6h"));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    scriptPath,
    "--file",
    file,
    "--max-checked-age-hours",
    "6",
    "--json"
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.maxAgeHours, 26);
  assert.deepEqual(parsed.errors, []);
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    components: []
  }));

  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /components\.postgres must be an object/u);
      assert.match(error.stderr, /components\.redis must be an object/u);
      return true;
    }
  );
});
