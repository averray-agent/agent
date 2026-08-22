import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_SESSION_PROBE_TIMEOUT_MS,
  startBoundedSessionProbe,
} from "./session-probe.js";

test("session probe budget is at most two seconds", () => {
  assert.ok(AUTH_SESSION_PROBE_TIMEOUT_MS <= 2_000);
});

test("a timed-out probe releases the wall and can still upgrade from a late session", async () => {
  let release;
  const probe = new Promise((resolve) => {
    release = resolve;
  });
  let deadline;
  const events = [];

  startBoundedSessionProbe({
    probe: () => probe,
    onDeadline: () => events.push("wall"),
    onResolved: (value, meta) => events.push(`${value}:${meta.late ? "late" : "fast"}`),
    schedule: (callback) => {
      deadline = callback;
      return 1;
    },
    cancel: () => {},
  });

  deadline();
  release("authenticated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["wall", "authenticated:late"]);
});

test("a session inside the budget upgrades without releasing the signed-out wall", async () => {
  const events = [];
  startBoundedSessionProbe({
    probe: () => "authenticated",
    onDeadline: () => events.push("wall"),
    onResolved: (value, meta) => events.push(`${value}:${meta.late ? "late" : "fast"}`),
    schedule: () => 1,
    cancel: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["authenticated:fast"]);
});
