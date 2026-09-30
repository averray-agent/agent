import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const script = new URL("./phone-push.sh", import.meta.url).pathname;
async function runPush(t, { configured = true, fail = false, args = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "phone-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = join(root, "capture");
  await writeFile(join(root, "curl"), `#!/bin/bash\nprintf '%s\\n' "$@" > "$CAPTURE"\ncat >> "$CAPTURE"\n${fail ? 'echo "$PHONE_PUSH_URL" >&2; exit 22' : 'exit 0'}\n`);
  await chmod(join(root, "curl"), 0o755);
  const child = exec("bash", [script, "Averray check", "4", "warning", "https://example.test/run", ...args], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE: capture,
      PHONE_PUSH_URL: configured ? "https://ntfy.example.test/synthetic-topic?auth=synthetic-token" : "" },
  });
  child.child.stdin.end("Synthetic check notification");
  try { return { code: 0, ...await child, capture }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr, capture }; }
}

test("phone push requires configured delivery", async (t) => {
  const result = await runPush(t, { configured: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /phone push not configured or undeliverable/);
});
test("phone push sends the body and notification headers", async (t) => {
  const result = await runPush(t);
  assert.equal(result.code, 0);
  const capture = await readFile(result.capture, "utf8");
  for (const value of ["Title: Averray check", "Priority: 4", "Tags: warning",
    "Click: https://example.test/run", "--data-binary", "@-", "Synthetic check notification"]) {
    assert.ok(capture.includes(value), value);
  }
  assert.equal(result.stdout + result.stderr, "");
});
test("phone push reports delivery failure without printing its credentials", async (t) => {
  const result = await runPush(t, { fail: true });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-topic|synthetic-token|ntfy\.example/);
});
