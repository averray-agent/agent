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
const encodeKey = (key) => Buffer.from(key).toString("base64");
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
  assert.deepEqual(step("key").env, { VPS_SSH_KEY_B64: "${{ steps.load.outputs.VPS_SSH_KEY_B64 }}" });
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

test("broker key validation decodes base64 before checking shape and preserves a private 0600 file", (t) => {
  const directory = temporary(t);
  assert.match(step("key").run, /base64 -d/u);
  for (const key of ["", "ssh-ed25519 FAKE-PUBLIC", "not-a-key"]) {
    assert.equal(shell(step("key").run, { RUNNER_TEMP: directory, VPS_SSH_KEY_B64: encodeKey(key) }).status, 1);
  }
  const path = join(directory, "workload-identity.key");
  for (const key of [fakeKey, `${fakeKey}\n`]) {
    const result = shell(step("key").run, { RUNNER_TEMP: directory, VPS_SSH_KEY_B64: encodeKey(key) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    assert.equal(readFileSync(path, "utf8"), key);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(step("cleanup").if, "always()");
  assert.equal(shell(step("cleanup").run, { RUNNER_TEMP: directory }).status, 0);
  assert.throws(() => statSync(path), { code: "ENOENT" });
});

test("key shape diagnostics contain only decoded counts and a prefix boolean, never key bytes", (t) => {
  const directory = temporary(t);
  for (const key of ["private-fixture-sentinel\nsecond-secret-line\n", "-----private-fixture-sentinel\nsecond-secret-line\n"]) {
    const result = shell(step("key").run, { RUNNER_TEMP: directory, VPS_SSH_KEY_B64: encodeKey(key) });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `::error::Decoded SSH key shape invalid (bytes=${Buffer.byteLength(key)}, lines=2, prefix_dashes=${key.startsWith("-----")})\n`);
    assert.ok(!result.stderr.includes(encodeKey(key)));
    for (const line of key.trimEnd().split("\n")) assert.ok(!result.stderr.includes(line));
  }
  const invalid = shell(step("key").run, { RUNNER_TEMP: directory, VPS_SSH_KEY_B64: "invalid-base64-fixture!" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  // GNU base64 rejects invalid characters; BSD may decode them permissively.
  // Either path must refuse the key and emit only the fixed safe diagnostics.
  assert.match(invalid.stderr, /^::error::(?:VPS_SSH_KEY_B64 is not valid base64|Decoded SSH key shape invalid \(bytes=\d+, lines=\d+, prefix_dashes=false\))\n$/u);
});

test("SSH key calendar records both homes rotating together", () => {
  const calendar = yaml.load(readFileSync(new URL("../../docs/SECRETS_CALENDAR.yml", import.meta.url), "utf8"));
  const entry = calendar.entries.find((item) => item.name === "vps-ssh-key");
  assert.match(entry.notes, /prod-ci\/vps-ssh-key/u);
  assert.match(entry.notes, /ci-prod-readonly variable VPS_SSH_KEY_B64/u);
  assert.match(entry.notes, /Rotate both together/u);
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
      VPS_SSH_KEY_B64: encodeKey(fakeKey), OP_INTEGRATION_KEY: "fixture-integration-secret",
      OP_WORKLOAD_ID: "fixture-workload-id", OP_ENVIRONMENT_ID: "fixture-environment-id",
      GITHUB_STEP_SUMMARY: path
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    assert.equal(readFileSync(path, "utf8"), names.map((name) => `${name}: ${outcome === "success" ? "pass" : "fail"}\n`).join(""));
  }
});
