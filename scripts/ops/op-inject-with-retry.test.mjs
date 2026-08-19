import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RETRY_SCRIPT = join(REPO_ROOT, "scripts/ops/op-inject-with-retry.sh");

async function runFixture(mode) {
  const root = await mkdtemp(join(tmpdir(), "op-inject-retry-"));
  const fakeBin = join(root, "bin");
  const counter = join(root, "attempts");
  const template = join(root, "template.env");
  const rendered = join(root, "rendered.env");
  const stdoutPath = join(root, "op.stdout");
  const stderrPath = join(root, "op.stderr");
  await mkdir(fakeBin);
  await writeFile(template, "SECRET=op://fixture/value\n");
  const fakeOp = join(fakeBin, "op");
  await writeFile(fakeOp, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$FAKE_OP_COUNTER" ]]; then count=$(cat "$FAKE_OP_COUNTER"); fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_OP_COUNTER"
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--out-file" ]]; then out="$2"; shift 2; else shift; fi
done
if [[ "$FAKE_OP_MODE" == "502_then_success" && "$count" == "1" ]]; then
  echo '[ERROR] (502) upstream unavailable' >&2
  exit 1
fi
if [[ "$FAKE_OP_MODE" == "always_503" ]]; then
  echo '[ERROR] status 503 upstream unavailable' >&2
  exit 1
fi
if [[ "$FAKE_OP_MODE" == "auth_401" ]]; then
  echo '[ERROR] status 401 invalid service token' >&2
  exit 1
fi
printf 'SECRET=resolved\n' > "$out"
`);
  await chmod(fakeOp, 0o755);

  const result = spawnSync("bash", [
    RETRY_SCRIPT,
    template,
    rendered,
    stdoutPath,
    stderrPath
  ], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_OP_COUNTER: counter,
      FAKE_OP_MODE: mode,
      OP_INJECT_RETRY_DELAY_SEC: "0"
    },
    encoding: "utf8"
  });
  return {
    ...result,
    attempts: Number(await readFile(counter, "utf8")),
    opStderr: await readFile(stderrPath, "utf8")
  };
}

test("op inject retries one 5xx and succeeds without exposing rendered output", async () => {
  const result = await runFixture("502_then_success");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.attempts, 2);
  assert.match(result.stderr, /retrying once/u);
  assert.doesNotMatch(result.stderr, /SECRET=resolved/u);
});

test("op inject does not retry a non-5xx failure", async () => {
  const result = await runFixture("auth_401");
  assert.notEqual(result.status, 0);
  assert.equal(result.attempts, 1);
  assert.match(result.opStderr, /401/u);
});

test("op inject stays fail-closed after the single 5xx retry", async () => {
  const result = await runFixture("always_503");
  assert.notEqual(result.status, 0);
  assert.equal(result.attempts, 2);
  assert.match(result.opStderr, /503/u);
});

test("render-vps-env routes op inject through the bounded retry helper", async () => {
  const renderScript = await readFile(
    join(REPO_ROOT, "scripts/ops/render-vps-env.sh"),
    "utf8"
  );

  assert.match(renderScript, /op-inject-with-retry\.sh/u);
  assert.doesNotMatch(renderScript, /^if ! op inject /mu);
});
