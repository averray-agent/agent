import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isTerminalStatus,
  parseDeliverablesOutput,
  parseStatusOutput,
} from "../src/harness-driver.js";

test("parseStatusOutput reads the real key-value status shape", async () => {
  const output = await readFile(new URL("./fixtures/status-completed.txt", import.meta.url), "utf8");
  const status = parseStatusOutput(output);
  assert.deepEqual(status, {
    run_id: "1c70ec98-f379-404e-8287-a3e513e8ca89",
    state: "learning_processed",
    attempt: "1",
    outcome: "completed",
    outcome_reason: "-",
    egress_policy: "deny_all []",
    created_at: "2026-07-21T10:00:00+00:00",
    updated_at: "2026-07-21T10:00:05+00:00",
  });
  assert.equal(isTerminalStatus(status), true);
});

test("terminal detection follows outcome presence rather than transient completed state", () => {
  assert.equal(isTerminalStatus({ state: "completed" }), false);
  assert.equal(isTerminalStatus({ state: "learning_queued", outcome: "partial" }), true);
  assert.equal(isTerminalStatus({ state: "learning_processed", outcome: "failed" }), true);
  assert.equal(isTerminalStatus({ state: "quarantined" }), true);
  assert.equal(isTerminalStatus({ state: "cancelled" }), true);
  assert.equal(isTerminalStatus({ state: "executing" }), false);
});

test("parseDeliverablesOutput maps artifact types to URIs", async () => {
  const output = await readFile(new URL("./fixtures/deliverables.txt", import.meta.url), "utf8");
  assert.deepEqual(parseDeliverablesOutput(output), {
    change_summary: "artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verification_report: "artifact://sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    workspace_patch: "artifact://sha256/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  });
});
