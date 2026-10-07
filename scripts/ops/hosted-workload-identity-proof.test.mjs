import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const workflows = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const filename = "hosted-workload-identity-proof.yml";
const source = readFileSync(join(workflows, filename), "utf8");
const workflow = yaml.load(source);
const job = workflow.jobs.proof;
const step = (id) => job.steps.find((entry) => entry.id === id);
const brokerEnv = {
  OP_WORKLOAD_ID: "${{ vars.OP_WORKLOAD_ID }}",
  OP_ENVIRONMENT_ID: "${{ vars.OP_ENVIRONMENT_ID }}",
  OP_INTEGRATION_KEY: "${{ secrets.OP_INTEGRATION_KEY }}"
};
const pemLine = (word) => `-----${word} OPENSSH PRIVATE KEY-----`;
const fakeKey = [pemLine("BEGIN"), "ssh-FAKE-TEST-ONLY", pemLine("END")].join("\n");
const shell = (script, env = {}) => spawnSync("bash", ["-c", script], {
  // Do not inherit workstation credentials into shell fixtures.
  env: { PATH: process.env.PATH, ...env }, encoding: "utf8"
});
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "workload-identity-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("workload identity drill is dispatch-only, production-scoped and broker-only", () => {
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(Object.keys(workflow.jobs), ["proof"]);
  assert.equal(job.environment, "production");
  assert.equal(job["timeout-minutes"], 5);
  assert.doesNotMatch(source, /OP_SERVICE_ACCOUNT_TOKEN|op:\/\//u);
  assert.deepEqual(step("preflight").env, brokerEnv);
  assert.deepEqual(step("load").env, brokerEnv);
  assert.deepEqual(step("load").with, { "export-env": false });
  assert.deepEqual(step("key").env, { VPS_SSH_KEY: "${{ steps.load.outputs.VPS_SSH_KEY }}" });
  assert.deepEqual(step("ssh").env, { VPS_HOST: "${{ secrets.VPS_HOST }}" });
  assert.equal(job.env, undefined);
});

test("OIDC write is granted only to the drill job during PR 1", () => {
  // PR 2 must deliberately extend this allow-list after two green days.
  for (const name of readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name))) {
    const document = yaml.load(readFileSync(join(workflows, name), "utf8"));
    const grants = [document.permissions, ...Object.values(document.jobs ?? {}).map((entry) => entry.permissions)];
    assert.ok(grants.every((grant) => grant !== "write-all"), `${name}: no implicit OIDC write`);
    assert.notEqual(document.permissions?.["id-token"], "write", `${name}: no workflow-wide OIDC grant`);
    for (const [id, entry] of Object.entries(document.jobs ?? {})) {
      if (name === filename && id === "proof") {
        assert.deepEqual(entry.permissions, { "id-token": "write", contents: "read" });
      } else {
        assert.notEqual(entry.permissions?.["id-token"], "write", `${name}/${id}: unexpected OIDC grant`);
      }
    }
  }
  assert.deepEqual(workflow.permissions, {});
});

test("broker action is pinned to the reviewed v5.0.1 commit, never a tag", () => {
  assert.match(step("load").uses, /^1password\/load-secrets-action@[a-f0-9]{40}$/u);
  assert.equal(step("load").uses, "1password/load-secrets-action@70062d7a876d3eb6334754fa26efd2fbd90c32f2");
});

test("broker preflight names every missing value and refuses each empty prerequisite", () => {
  const names = Object.keys(brokerEnv);
  const valid = Object.fromEntries(names.map((name) => [name, `fixture-${name}`]));
  const empty = shell(step("preflight").run, Object.fromEntries(names.map((name) => [name, ""])));
  assert.equal(empty.status, 1);
  for (const name of names) {
    assert.ok(empty.stderr.includes(`Missing ${name}`));
    const result = shell(step("preflight").run, { ...valid, [name]: "" });
    assert.equal(result.status, 1, name);
    assert.ok(result.stderr.includes(`Missing ${name}`));
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-/u);
  }
  const result = shell(step("preflight").run, valid);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
});

test("broker key validation rejects empty/public keys and writes a private 0600 file without logging it", (t) => {
  const directory = temporary(t);
  for (const key of ["", "ssh-ed25519 FAKE-PUBLIC", "not-a-key"]) {
    assert.equal(shell(step("key").run, { RUNNER_TEMP: directory, VPS_SSH_KEY: key }).status, 1);
  }
  const result = shell(step("key").run, { RUNNER_TEMP: directory, VPS_SSH_KEY: fakeKey });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  const path = join(directory, "workload-identity.key");
  assert.equal(readFileSync(path, "utf8"), `${fakeKey}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(step("cleanup").if, "always()");
  assert.equal(shell(step("cleanup").run, { RUNNER_TEMP: directory }).status, 0);
  assert.throws(() => statSync(path), { code: "ENOENT" });
});

test("broker SSH proof sends only the echo command with the broker key and batch host checking", (t) => {
  const directory = temporary(t);
  // Stub the executable, never connect to a host during tests.
  writeFileSync(join(directory, "ssh"), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const env = { PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, VPS_HOST: "fixture.invalid" };
  const result = shell(step("ssh").run, env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "-i", `${directory}/workload-identity.key`,
    "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=20",
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
    "ubuntu@fixture.invalid", "echo workload-identity-ok"
  ]);
  assert.equal(shell(step("ssh").run, { ...env, VPS_HOST: "" }).status, 1);
});

test("drill summary emits only fixed step pass/fail results, never secrets, IDs or key fragments", (t) => {
  const directory = temporary(t);
  const summary = job.steps.find((entry) => entry.name === "Summarize drill");
  assert.equal(summary.if, "always()");
  const names = ["PREFLIGHT", "LOAD", "KEY", "SSH", "CLEANUP"];
  assert.deepEqual(summary.env, Object.fromEntries(names.map((name) => [name, `\${{ steps.${name.toLowerCase()}.outcome }}`])));
  assert.doesNotMatch(summary.run, /ssh-|BEGIN|VPS_SSH_KEY|OP_(?:WORKLOAD_ID|ENVIRONMENT_ID|INTEGRATION_KEY)/u);
  for (const outcome of ["success", "failure", "skipped", "cancelled", "", fakeKey]) {
    const path = join(directory, "summary");
    writeFileSync(path, "");
    const result = shell(summary.run, {
      ...Object.fromEntries(names.map((name) => [name, outcome])),
      VPS_SSH_KEY: fakeKey, OP_INTEGRATION_KEY: "fixture-integration-secret",
      OP_WORKLOAD_ID: "fixture-workload-id", OP_ENVIRONMENT_ID: "fixture-environment-id",
      GITHUB_STEP_SUMMARY: path
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    assert.equal(readFileSync(path, "utf8"), names.map((name) => `${name}: ${outcome === "success" ? "pass" : "fail"}\n`).join(""));
  }
});
