import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./indexer-sync-cache-reset.sh", import.meta.url));

async function fixture(t, overrides = {}, args = []) {
  const dir = await mkdtemp(join(tmpdir(), "indexer-cache-reset-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const trace = join(dir, "calls.jsonl");
  await writeFile(trace, "");
  await writeFile(join(dir, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const sql = args[0] === 'exec' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.RESET_TEST_TRACE, JSON.stringify({ args, sql }) + '\\n');
if (args[0] === 'inspect') {
  if (process.env.RESET_TEST_INSPECT_FAIL === '1') process.exit(1);
  console.log(process.env.RESET_TEST_RUNNING || 'false');
} else if (args[0] === 'exec') {
  process.exit(Number(process.env.RESET_TEST_SQL_EXIT || '0'));
} else process.exit(99);
`, { mode: 0o755 });
  await writeFile(join(dir, "flock"), `#!${process.execPath}
process.exit(process.argv[3] === process.env.RESET_TEST_LOCKED_FD ? 1 : 0);
`, { mode: 0o755 });
  const result = spawnSync("bash", [script, ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH}`, INDEXER_FRESH_SCHEMA: "1",
      DEPLOY_LOCK_FILE: join(dir, "deploy.lock"), INDEXER_SCHEMA_LOCK_FILE: join(dir, "schema.lock"),
      RESET_TEST_TRACE: trace, ...overrides,
    }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  const calls = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  return { ...result, calls, output: result.stdout + result.stderr };
}

test("cache reset refuses without explicit INDEXER_FRESH_SCHEMA=1 before touching Docker", async (t) => {
  for (const flag of [undefined, "", "0", "true", "yes"]) {
    const result = await fixture(t, { INDEXER_FRESH_SCHEMA: flag });
    assert.equal(result.status, 1, `must refuse flag ${flag}`);
    assert.match(result.output, /Refusing cache reset:.*INDEXER_FRESH_SCHEMA=1/u);
    assert.deepEqual(result.calls, []);
  }
});

test("fresh-schema reset drops only mainnet ponder_sync and never restarts or dispatches", async (t) => {
  const result = await fixture(t);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [
    { args: ["inspect", "--format", "{{.State.Running}}", "agent-mainnet-indexer"], sql: "" },
    { args: ["exec", "-i", "agent-postgres", "psql", "-X", "--set=ON_ERROR_STOP=1", "--username=agent", "--dbname=averray_mainnet"],
      sql: "BEGIN;\nSET LOCAL lock_timeout = '5s';\nDROP SCHEMA ponder_sync CASCADE;\nCOMMIT;\n" },
  ]);
  assert.match(result.output, /Dropped averray_mainnet\.ponder_sync/u);
  assert.match(result.output, /remains stopped.*run_indexer=1 indexer_fresh_schema=1/u);
});

test("cache reset refuses a running or uninspectable indexer before SQL", async (t) => {
  for (const env of [{ RESET_TEST_RUNNING: "true" }, { RESET_TEST_INSPECT_FAIL: "1" }]) {
    const result = await fixture(t, env);
    assert.equal(result.status, 1);
    assert.match(result.output, /stop agent-mainnet-indexer first/u);
    assert.equal(result.calls.length, 1);
  }
});

test("cache reset respects both production deploy and schema locks", async (t) => {
  for (const fd of ["9", "8"]) {
    const result = await fixture(t, { RESET_TEST_LOCKED_FD: fd });
    assert.equal(result.status, 1);
    assert.match(result.output, /lock is held/u);
    assert.deepEqual(result.calls, []);
  }
});

test("cache reset reports SQL failure without claiming the cache was dropped", async (t) => {
  const result = await fixture(t, { RESET_TEST_SQL_EXIT: "3" });
  assert.equal(result.status, 1);
  assert.match(result.output, /Cache reset failed/u);
  assert.doesNotMatch(result.output, /Dropped averray_mainnet/u);
  assert.equal(result.calls.length, 2);
});

test("cache reset rejects database, schema, and range arguments", async (t) => {
  const result = await fixture(t, {}, ["--from-block", "20501734"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /no arguments/u);
  assert.deepEqual(result.calls, []);
});
