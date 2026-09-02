import test from "node:test";
import assert from "node:assert/strict";

import { runGuardedSubmit } from "./guarded-submit.js";

test("structured-required job validates first; invalid response prevents /jobs/submit", async () => {
  const calls = [];
  const fetcher = async ([path, init]) => {
    calls.push({ path, init });
    if (path === "/jobs/validate-submission") {
      return {
        valid: false,
        message: "missing required field `title`",
        details: { path: "/data/title" }
      };
    }
    throw new Error("/jobs/submit must not be called when validation fails");
  };

  const outcome = await runGuardedSubmit({
    jobId: "job-1",
    sessionId: "session-1",
    submission: { data: {} },
    structuredSubmissionRequired: true,
    fetcher
  });

  assert.equal(outcome.status, "validation_failed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/jobs/validate-submission");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    jobId: "job-1",
    submission: { data: {} }
  });
  assert.equal(outcome.validation.valid, false);
  assert.equal(outcome.validation.details.path, "/data/title");
});

test("structured-required job submits after a valid validation, and forwards the response", async () => {
  const calls = [];
  const fetcher = async ([path, init]) => {
    calls.push({ path, init });
    if (path === "/jobs/validate-submission") return { valid: true };
    if (path === "/jobs/submit") return { ok: true, sessionId: "session-1" };
    throw new Error(`unexpected path ${path}`);
  };

  const outcome = await runGuardedSubmit({
    jobId: "job-1",
    sessionId: "session-1",
    submission: { data: { title: "hello" } },
    structuredSubmissionRequired: true,
    fetcher
  });

  assert.equal(outcome.status, "submitted");
  assert.deepEqual(outcome.submitResponse, { ok: true, sessionId: "session-1" });
  assert.deepEqual(calls.map((c) => c.path), ["/jobs/validate-submission", "/jobs/submit"]);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    sessionId: "session-1",
    submission: { data: { title: "hello" } }
  });
});

test("non-structured job skips the validation step entirely", async () => {
  const calls = [];
  const fetcher = async ([path]) => {
    calls.push(path);
    return { ok: true };
  };

  const outcome = await runGuardedSubmit({
    jobId: "job-1",
    sessionId: "session-1",
    submission: "free-text",
    structuredSubmissionRequired: false,
    fetcher
  });

  assert.equal(outcome.status, "submitted");
  assert.deepEqual(calls, ["/jobs/submit"]);
});

test("a malformed validation response (no `valid` field) is treated as invalid and gates the submit", async () => {
  // The validation endpoint is contract-typed but a hostile / drifted
  // intermediate could strip the `valid` boolean. We must not fall
  // through to /jobs/submit on an ambiguous response.
  const calls = [];
  const fetcher = async ([path]) => {
    calls.push(path);
    if (path === "/jobs/validate-submission") return { issues: [] };
    throw new Error("/jobs/submit must not be called when validation is ambiguous");
  };

  const outcome = await runGuardedSubmit({
    jobId: "job-1",
    sessionId: "session-1",
    submission: { data: {} },
    structuredSubmissionRequired: true,
    fetcher
  });

  assert.equal(outcome.status, "validation_failed");
  assert.deepEqual(calls, ["/jobs/validate-submission"]);
});

test("validation surfaces the JSON-pointer path so the operator can fix the draft", async () => {
  const fetcher = async ([path]) => {
    if (path === "/jobs/validate-submission") {
      return {
        valid: false,
        message: "missing required field",
        details: { path: "/data/items/0/url" }
      };
    }
    throw new Error("/jobs/submit must not be called when validation fails");
  };

  const outcome = await runGuardedSubmit({
    jobId: "job-1",
    sessionId: "session-1",
    submission: { data: { items: [{}] } },
    structuredSubmissionRequired: true,
    fetcher
  });

  assert.equal(outcome.status, "validation_failed");
  assert.equal(outcome.validation.details.path, "/data/items/0/url");
});
