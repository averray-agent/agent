import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = resolve(repoRoot, "scripts", "ops", "check-native-xcm-evidence-pack.mjs");
const fixtureDir = resolve(repoRoot, "docs", "fixtures", "xcm");

async function loadFixture(name) {
  return JSON.parse(await readFile(resolve(fixtureDir, name), "utf8"));
}

async function writePack(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "native-xcm-evidence-pack-"));
  const pack = {
    deposit: await loadFixture("native-observer-evidence.sample.json"),
    withdraw: await loadFixture("native-observer-evidence-withdraw.sample.json"),
    failure: await loadFixture("native-observer-evidence-failure.sample.json")
  };

  for (const [key, updater] of Object.entries(overrides)) {
    pack[key] = typeof updater === "function" ? updater(pack[key]) : updater;
  }

  const paths = {};
  for (const [key, doc] of Object.entries(pack)) {
    paths[key] = join(dir, `${key}.json`);
    await writeFile(paths[key], `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
  paths.decisionOutput = join(dir, "decision.md");
  return paths;
}

function cliArgs(paths, extra = []) {
  return [
    scriptPath,
    "--deposit",
    paths.deposit,
    "--withdraw",
    paths.withdraw,
    "--failure",
    paths.failure,
    ...extra
  ];
}

test("evidence pack accepts production-candidate SetTopic correlation", async () => {
  const paths = await writePack();
  const { stdout } = await execFileAsync(process.execPath, cliArgs(paths, [
    "--decision-output",
    paths.decisionOutput
  ]));

  assert.match(stdout, /Native XCM evidence pack validated/u);
  assert.match(stdout, /Correlation method: request_id_in_message/u);
  assert.match(stdout, /Decision: SetTopic\/request-id correlation is supported/u);

  const decision = await readFile(paths.decisionOutput, "utf8");
  assert.match(decision, /SetTopic\/request-id correlation is supported/u);
  assert.match(decision, /Correlation method: `request_id_in_message`/u);
  assert.match(decision, /\| deposit \| deposit \| succeeded/u);
  assert.match(decision, /\| withdraw \| withdraw \| succeeded/u);
  assert.match(decision, /\| failure \| deposit \| failed/u);
});

test("evidence pack rejects mixed production correlation methods", async () => {
  const paths = await writePack({
    withdraw: (doc) => ({
      ...doc,
      correlation: {
        ...doc.correlation,
        method: "remote_ref"
      }
    })
  });

  await assert.rejects(
    () => execFileAsync(process.execPath, cliArgs(paths)),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /all captures must use the same production correlation method/u);
      assert.match(error.stderr, /request_id_in_message, remote_ref/u);
      return true;
    }
  );
});

test("evidence pack rejects staging-only ledger join correlation", async () => {
  const makeLedgerJoin = (doc) => ({
    ...doc,
    correlation: {
      ...doc.correlation,
      method: "ledger_join",
      confidence: "staging"
    }
  });
  const paths = await writePack({
    deposit: makeLedgerJoin,
    withdraw: makeLedgerJoin,
    failure: makeLedgerJoin
  });

  await assert.rejects(
    () => execFileAsync(process.execPath, cliArgs(paths)),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /ledger_join evidence is staging-only/u);
      return true;
    }
  );
});

test("evidence pack rejects staging confidence even for remote_ref fallback", async () => {
  const makeRemoteRefStaging = (doc) => ({
    ...doc,
    correlation: {
      ...doc.correlation,
      method: "remote_ref",
      confidence: "staging"
    },
    remoteRef: doc.remoteRef ?? `0x${"ab".repeat(32)}`,
    decision: {
      ...doc.decision,
      remoteRef: doc.decision.remoteRef ?? `0x${"ab".repeat(32)}`
    }
  });
  const paths = await writePack({
    deposit: makeRemoteRefStaging,
    withdraw: makeRemoteRefStaging,
    failure: makeRemoteRefStaging
  });

  await assert.rejects(
    () => execFileAsync(process.execPath, cliArgs(paths)),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /deposit evidence must be production_candidate or production; got staging/u);
      return true;
    }
  );
});

test("evidence pack rejects wrong capture slot direction", async () => {
  const paths = await writePack({
    deposit: await loadFixture("native-observer-evidence-withdraw.sample.json")
  });

  await assert.rejects(
    () => execFileAsync(process.execPath, cliArgs(paths)),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /deposit evidence must have direction=deposit; got withdraw/u);
      return true;
    }
  );
});
