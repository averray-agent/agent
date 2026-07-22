import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/emit-intent.mjs", import.meta.url));
const sample = fileURLToPath(new URL("../examples/github-issue-job.json", import.meta.url));
const unverifiable = fileURLToPath(new URL("./fixtures/unverifiable-job.json", import.meta.url));

test("emit-intent reads a file and emits deterministic JSON", () => {
  const result = spawnSync(process.execPath, [bin, sample, "--workspace", "/tmp/workspace"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  // npm test is not baseline-capable (kernel baselines pytest only): one check.
  assert.deepEqual(
    JSON.parse(result.stdout).spec.acceptance.map((check) => check.id),
    ["job-checks"],
  );
});

test("emit-intent emits unverifiable intent but exits 3", () => {
  const result = spawnSync(
    process.execPath,
    [bin, unverifiable, "--workspace", "/tmp/workspace"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 3);
  assert.deepEqual(JSON.parse(result.stdout).spec.acceptance, []);
  assert.match(result.stderr, /not eligible for automated submission/);
});

test("emit-intent reads job JSON from stdin", async () => {
  const input = await readFile(sample, "utf8");
  const result = spawnSync(process.execPath, [bin, "--workspace", "/tmp/workspace"], {
    encoding: "utf8",
    input,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).metadata.labels.issue_number, "741");
});
