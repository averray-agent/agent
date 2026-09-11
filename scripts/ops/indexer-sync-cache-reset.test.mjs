import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./indexer-sync-cache-reset.sh", import.meta.url));

const previousClaim = "previous_mainnet_schema\n";
const defaultUrl = "postgresql://indexer_owner:reset-fixture-secret@postgres:5432/indexer_actual_mainnet";
const defaultNetworks = [
  { shared: { IPAddress: "172.20.0.2", GlobalIPv6Address: "fd00::2", Aliases: ["postgres", "agent-postgres"] } },
  { shared: { IPAddress: "172.20.0.3" } },
];

async function fixture(t, overrides = {}, args = [], options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "indexer-cache-reset-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const trace = join(dir, "calls.jsonl");
  const lockTrace = join(dir, "locks.jsonl");
  const stateDir = join(dir, "state");
  const schemaStateFile = join(stateDir, "indexer.database-schema.mainnet");
  const envFile = join(dir, "indexer.env");
  await mkdir(stateDir);
  await writeFile(schemaStateFile, previousClaim);
  await writeFile(join(stateDir, "indexer.app-identity.mainnet"), "keep identity\n");
  await writeFile(join(stateDir, "indexer.database-schema.testnet"), "keep testnet\n");
  await writeFile(envFile, options.envText ?? `DATABASE_URL=${options.databaseUrl ?? defaultUrl}\n`);
  await writeFile(trace, "");
  await writeFile(lockTrace, "");
  await writeFile(join(dir, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const sql = args[0] === 'exec' ? fs.readFileSync(0, 'utf8') : '';
const call = { args, sql };
if (args[0] === 'exec') call.claimAtSql = fs.existsSync(process.env.RESET_TEST_CLAIM)
  ? fs.readFileSync(process.env.RESET_TEST_CLAIM, 'utf8') : null;
fs.appendFileSync(process.env.RESET_TEST_TRACE, JSON.stringify(call) + '\\n');
if (args[0] === 'inspect' && args[2] === '{{.State.Running}}') {
  if (process.env.RESET_TEST_INSPECT_FAIL === '1') process.exit(1);
  console.log(process.env.RESET_TEST_RUNNING || 'false');
} else if (args[0] === 'inspect' && args[2] === '{{json .NetworkSettings.Networks}}') {
  if (process.env.RESET_TEST_NETWORKS_FAIL === '1') process.exit(1);
  for (const networks of JSON.parse(process.env.RESET_TEST_NETWORKS)) console.log(JSON.stringify(networks));
} else if (args[0] === 'exec') {
  process.exit(Number(process.env.RESET_TEST_SQL_EXIT || '0'));
} else process.exit(99);
`, { mode: 0o755 });
  await writeFile(join(dir, "flock"), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.RESET_TEST_LOCK_TRACE, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(process.argv[3] === process.env.RESET_TEST_LOCKED_FD ? 1 : 0);
`, { mode: 0o755 });
  const result = spawnSync("bash", [script, ...args], {
    env: {
      PATH: `${dir}:${process.env.PATH}`, INDEXER_FRESH_SCHEMA: "1",
      DEPLOY_LOCK_FILE: join(dir, "deploy.lock"), INDEXER_SCHEMA_LOCK_FILE: join(dir, "schema.lock"),
      INDEXER_ENV_FILE: envFile, DEPLOY_STATE_DIR: stateDir,
      RESET_TEST_TRACE: trace, RESET_TEST_LOCK_TRACE: lockTrace, RESET_TEST_CLAIM: schemaStateFile,
      RESET_TEST_NETWORKS: JSON.stringify(options.networks ?? defaultNetworks), ...overrides,
    }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  const calls = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const locks = (await readFile(lockTrace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const claim = await readFile(schemaStateFile, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  assert.equal(await readFile(join(stateDir, "indexer.app-identity.mainnet"), "utf8"), "keep identity\n");
  assert.equal(await readFile(join(stateDir, "indexer.database-schema.testnet"), "utf8"), "keep testnet\n");
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes("reset-fixture-secret"), "never print URL credentials, even on parse errors");
  assert.ok(!JSON.stringify(calls).includes("reset-fixture-secret"), "never put URL credentials in Docker argv");
  const lockFilesExist = [join(dir, "deploy.lock"), join(dir, "schema.lock")].some(existsSync);
  return { ...result, calls, locks, lockFilesExist, claim, schemaStateFile, output };
}

test("cache reset refuses without explicit INDEXER_FRESH_SCHEMA=1 before touching Docker", async (t) => {
  for (const flag of [undefined, "", "0", "true", "yes"]) {
    const result = await fixture(t, { INDEXER_FRESH_SCHEMA: flag });
    assert.equal(result.status, 1, `must refuse flag ${flag}`);
    assert.match(result.output, /Refusing cache reset:.*INDEXER_FRESH_SCHEMA=1/u);
    assert.deepEqual(result.calls, []);
    assert.equal(result.claim, previousClaim);
  }
});

test("fresh-schema reset drops only mainnet ponder_sync and never restarts or dispatches", async (t) => {
  const result = await fixture(t);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [
    { args: ["inspect", "--format", "{{.State.Running}}", "agent-mainnet-indexer"], sql: "" },
    { args: ["inspect", "--format", "{{json .NetworkSettings.Networks}}", "agent-postgres", "agent-mainnet-indexer"], sql: "" },
    { args: ["exec", "-i", "agent-postgres", "psql", "-X", "--set=ON_ERROR_STOP=1", "--username=indexer_owner", "--dbname=indexer_actual_mainnet", "--port=5432"],
      sql: "BEGIN;\nSET LOCAL lock_timeout = '5s';\nDROP SCHEMA ponder_sync CASCADE;\nCOMMIT;\n", claimAtSql: previousClaim },
  ]);
  assert.deepEqual(result.locks, [["-n", "9"], ["-n", "8"]]);
  assert.match(result.output, /Dropped indexer_actual_mainnet\.ponder_sync/u);
  assert.match(result.output, /remains stopped.*run_indexer=1 indexer_fresh_schema=1/u);
});

test("psql target follows DATABASE_URL user, dbname, and port instead of a hardcoded database", async (t) => {
  for (const database of ["agent", "different_live_index"]) {
    const result = await fixture(t, { DATABASE_URL: "postgres://stale@elsewhere/ignored" }, [], {
      databaseUrl: `postgres://owner%5Fmainnet:reset-fixture-secret@postgres:5433/${database}`,
    });
    assert.equal(result.status, 0, result.output);
    const sqlCall = result.calls.find(call => call.args[0] === "exec");
    assert.ok(sqlCall.args.includes(`--dbname=${database}`));
    assert.ok(sqlCall.args.includes("--username=owner_mainnet"));
    assert.ok(sqlCall.args.includes("--port=5433"));
    assert.match(result.output, new RegExp(`host=postgres container=agent-postgres user=owner_mainnet dbname=${database} port=5433`));
    assert.ok(result.output.indexOf("Reset target:") < result.output.indexOf("Dropped "));
  }
});

test("print-target is read-only without the fresh flag or a stopped indexer", async (t) => {
  const result = await fixture(t, { INDEXER_FRESH_SCHEMA: undefined, RESET_TEST_RUNNING: "true" }, ["--print-target"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /host=postgres container=agent-postgres user=indexer_owner dbname=indexer_actual_mainnet port=5432/u);
  assert.match(result.output, /Print-target only/u);
  assert.equal(result.claim, previousClaim);
  assert.deepEqual(result.locks, [], "dry run does not create/acquire lock files");
  assert.equal(result.lockFilesExist, false);
  assert.deepEqual(result.calls, [{
    args: ["inspect", "--format", "{{json .NetworkSettings.Networks}}", "agent-postgres", "agent-mainnet-indexer"], sql: "",
  }]);
});

test("DATABASE_URL host must identify Postgres on a shared indexer network", async (t) => {
  for (const host of ["elsewhere.example", "postgres.evil.example", "127.0.0.1"]) {
    const result = await fixture(t, {}, [], { databaseUrl: `postgresql://owner:reset-fixture-secret@${host}/actual_index` });
    assert.equal(result.status, 1);
    assert.match(result.output, /host is not agent-postgres/u);
    assert.ok(result.calls.every(call => call.args[0] === "inspect"));
    assert.equal(result.claim, previousClaim);
  }
  const isolated = await fixture(t, {}, [], { networks: [defaultNetworks[0], { unrelated: {} }] });
  assert.equal(isolated.status, 1);
  assert.equal(isolated.claim, previousClaim);
  const uninspectable = await fixture(t, { RESET_TEST_NETWORKS_FAIL: "1" });
  assert.equal(uninspectable.status, 1);
  assert.equal(uninspectable.claim, previousClaim);
});

test("print-target accepts inspected Postgres aliases and addresses, not just one literal hostname", async (t) => {
  for (const host of ["agent-postgres", "172.20.0.2", "[fd00::2]"]) {
    const result = await fixture(t, {}, ["--print-target"], {
      databaseUrl: `postgresql://owner:reset-fixture-secret@${host}/actual_index`,
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.claim, previousClaim);
  }
});

test("rendered env parsing never sources shell text and rejects malformed or redirected targets", async (t) => {
  const quoted = await fixture(t, {}, ["--print-target"], {
    envText: `# runtime env\nDATABASE_URL='${defaultUrl}'\nDANGER=$(exit 19)\n`,
  });
  assert.equal(quoted.status, 0, quoted.output);
  for (const url of ["", "reset-fixture-secret:not-a-url", "op://mainnet-indexer/database-url/password",
    "postgres://owner:reset-fixture-secret@postgres", "postgres://owner:reset-fixture-secret@postgres/db?host=elsewhere",
    "postgres://owner:reset-fixture-secret@postgres/host%3Delsewhere", "postgres://owner:reset-fixture-secret@postgres:99999/db"]) {
    const result = await fixture(t, {}, ["--print-target"], { databaseUrl: url });
    assert.equal(result.status, 1, `must reject malformed or redirected target`);
    assert.equal(result.claim, previousClaim);
    assert.deepEqual(result.calls, []);
  }
});

test("successful DROP removes only the persisted mainnet schema claim after SQL", async (t) => {
  const result = await fixture(t);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.find(call => call.args[0] === "exec").claimAtSql, previousClaim);
  assert.equal(result.claim, null, "next deploy must mint a fresh schema even without a workflow flag");
  assert.ok(result.output.includes(`Removed persisted mainnet schema claim: ${result.schemaStateFile}`));
});

test("cache reset refuses a running or uninspectable indexer before SQL", async (t) => {
  for (const env of [{ RESET_TEST_RUNNING: "true" }, { RESET_TEST_INSPECT_FAIL: "1" }]) {
    const result = await fixture(t, env);
    assert.equal(result.status, 1);
    assert.match(result.output, /stop agent-mainnet-indexer first/u);
    assert.equal(result.calls.length, 1);
    assert.equal(result.claim, previousClaim);
  }
});

test("cache reset respects both production deploy and schema locks", async (t) => {
  for (const fd of ["9", "8"]) {
    const result = await fixture(t, { RESET_TEST_LOCKED_FD: fd });
    assert.equal(result.status, 1);
    assert.match(result.output, /lock is held/u);
    assert.deepEqual(result.calls, []);
    assert.equal(result.claim, previousClaim);
  }
});

test("SQL failure leaves the persisted mainnet schema claim byte-for-byte untouched", async (t) => {
  const result = await fixture(t, { RESET_TEST_SQL_EXIT: "3" });
  assert.equal(result.status, 1);
  assert.match(result.output, /Cache reset failed/u);
  assert.doesNotMatch(result.output, /Dropped |Removed persisted mainnet schema claim/u);
  assert.equal(result.calls.length, 3);
  assert.equal(result.calls.find(call => call.args[0] === "exec").claimAtSql, previousClaim);
  assert.equal(result.claim, previousClaim);
});

test("cache reset rejects database, schema, and range arguments", async (t) => {
  const result = await fixture(t, {}, ["--from-block", "20501734"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /no target\/range arguments/u);
  assert.deepEqual(result.calls, []);
});
