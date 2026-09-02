import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, utimes } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-backup-readiness.sh"
);

async function setupBackupDir(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), "backup-readiness-"));
  if (opts.postgres) {
    const pgDir = join(root, "postgres");
    await mkdir(pgDir, { recursive: true });
    for (const [name, ageHours] of opts.postgres) {
      const file = join(pgDir, name);
      await writeFile(file, "placeholder dump\n", "utf8");
      const mtime = new Date(Date.now() - ageHours * 3600 * 1000);
      await utimes(file, mtime, mtime);
    }
  }
  if (opts.redis) {
    const redisDir = join(root, "redis");
    await mkdir(redisDir, { recursive: true });
    for (const [name, ageHours] of opts.redis) {
      const file = join(redisDir, name);
      await writeFile(file, "placeholder rdb\n", "utf8");
      const mtime = new Date(Date.now() - ageHours * 3600 * 1000);
      await utimes(file, mtime, mtime);
    }
  }
  return root;
}

async function runScript(backupDir, extraArgs = []) {
  try {
    const { stdout, stderr } = await execFileAsync(scriptPath, [
      "--backup-dir",
      backupDir,
      ...extraArgs,
    ]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

test("readiness check passes when both fresh backups are present", async () => {
  const dir = await setupBackupDir({
    postgres: [["agent-20260516-010000.sql.gz", 1]],
    redis: [["redis-20260516-010000.rdb.gz", 2]],
  });
  const result = await runScript(dir);
  assert.equal(result.code, 0, `expected 0, got stderr: ${result.stderr}`);
  assert.match(result.stdout, /postgres\s+ok/);
  assert.match(result.stdout, /redis\s+ok/);
  assert.match(result.stdout, /Overall: ok/);
});

test("readiness check fails when the postgres directory has no matching files", async () => {
  const dir = await setupBackupDir({
    postgres: [], // dir exists, no files
    redis: [["redis-20260516-010000.rdb.gz", 1]],
  });
  const result = await runScript(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /postgres\s+no_files_match/);
  assert.match(result.stdout, /redis\s+ok/);
  assert.match(result.stdout, /Overall: not_ok/);
});

test("readiness check fails when the redis directory does not exist at all", async () => {
  const dir = await setupBackupDir({
    postgres: [["agent-20260516-010000.sql.gz", 1]],
    // no redis dir at all
  });
  const result = await runScript(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /redis\s+missing_directory/);
});

test("readiness check fails when the newest backup is older than the age threshold", async () => {
  const dir = await setupBackupDir({
    // 48h old > default 26h threshold
    postgres: [["agent-20260514-010000.sql.gz", 48]],
    redis: [["redis-20260516-010000.rdb.gz", 1]],
  });
  const result = await runScript(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /postgres\s+stale/);
  assert.match(result.stdout, /threshold is 26h/);
});

test("readiness check picks the newest file when multiple candidates exist", async () => {
  const dir = await setupBackupDir({
    postgres: [
      ["agent-old.sql.gz", 200],
      ["agent-fresh.sql.gz", 1],
      ["agent-mid.sql.gz", 50],
    ],
    redis: [["redis-20260516-010000.rdb.gz", 1]],
  });
  const result = await runScript(dir);
  assert.equal(result.code, 0);
  // The reported file path must be the fresh one, not the older candidates.
  assert.match(result.stdout, /agent-fresh\.sql\.gz/);
});

test("--max-age-hours tightens the threshold and surfaces a stale postgres", async () => {
  const dir = await setupBackupDir({
    postgres: [["agent-20260516-010000.sql.gz", 5]],
    redis: [["redis-20260516-010000.rdb.gz", 5]],
  });
  // Tighten to 2h — both backups are now 5h old.
  const result = await runScript(dir, ["--max-age-hours", "2"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /postgres\s+stale/);
  assert.match(result.stdout, /redis\s+stale/);
  assert.match(result.stdout, /threshold is 2h/);
});

test("--json mode emits a parseable status document with components and overall verdict", async () => {
  const dir = await setupBackupDir({
    postgres: [["agent-20260516-010000.sql.gz", 1]],
    redis: [["redis-20260516-010000.rdb.gz", 1]],
  });
  const result = await runScript(dir, ["--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.overallStatus, "ok");
  assert.equal(parsed.maxAgeHours, 26);
  assert.equal(parsed.backupDir, dir);
  assert.equal(parsed.components.length, 2);
  const byName = Object.fromEntries(parsed.components.map((c) => [c.name, c]));
  assert.equal(byName.postgres.status, "ok");
  assert.equal(byName.redis.status, "ok");
  assert.match(byName.postgres.file, /\.sql\.gz$/);
});

test("invalid --max-age-hours value fails closed with a non-zero exit", async () => {
  const dir = await setupBackupDir({
    postgres: [["agent-20260516-010000.sql.gz", 1]],
    redis: [["redis-20260516-010000.rdb.gz", 1]],
  });
  const result = await runScript(dir, ["--max-age-hours", "0"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /must be a positive integer/);
});
