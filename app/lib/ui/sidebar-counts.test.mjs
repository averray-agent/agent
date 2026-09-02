import test from "node:test";
import assert from "node:assert/strict";

import {
  openJobsCount,
  activeSessionsCount,
  openDisputesCount,
} from "./sidebar-counts.js";

test("openJobsCount: array length, envelope shapes, and load state", () => {
  assert.equal(openJobsCount([{}, {}, {}]), 3);
  assert.equal(openJobsCount({ jobs: [{}, {}] }), 2);
  assert.equal(openJobsCount({ items: [{}] }), 1);
  assert.equal(openJobsCount([]), 0); // loaded-empty is a real 0
  assert.equal(openJobsCount(undefined), undefined); // loading → no badge
  assert.equal(openJobsCount({ nope: 1 }), undefined); // unrecognized shape → no badge
});

test("activeSessionsCount: only in-flight (active/submitted/disputed) sessions", () => {
  const sessions = [
    { status: "claimed" }, // → active (in flight)
    { status: "active" }, // in flight
    { status: "submitted" }, // in flight
    { status: "disputed" }, // in flight (needs action)
    { status: "approved" }, // terminal-ish → excluded
    { status: "resolved" }, // maps to approved → excluded
    { status: "settled" }, // terminal → excluded
    { status: "closed" }, // → settled → excluded
    { status: "rejected" }, // terminal → excluded
    { status: "slashed" }, // terminal → excluded
  ];
  assert.equal(activeSessionsCount(sessions), 4);
  assert.equal(activeSessionsCount({ sessions }), 4);
  assert.equal(activeSessionsCount({ history: [{ state: "submitted" }] }), 1);
  assert.equal(activeSessionsCount([]), 0);
  assert.equal(activeSessionsCount(undefined), undefined);
  assert.equal(activeSessionsCount({ nope: 1 }), undefined);
});

test("openDisputesCount: open = no verdict and status not resolved/closed", () => {
  const disputes = [
    { status: "open" }, // open
    { status: "awaiting_evidence" }, // open
    { status: "escalated" }, // open
    { state: "under-review" }, // open
    { status: "resolved" }, // resolved
    { status: "closed" }, // resolved
    { status: "open", verdict: "uphold" }, // verdict present → resolved
    {}, // defaults to open
  ];
  assert.equal(openDisputesCount(disputes), 5);
  assert.equal(openDisputesCount({ disputes }), 5);
  assert.equal(openDisputesCount([]), 0); // queue clear is a real 0
  assert.equal(openDisputesCount(undefined), undefined);
  assert.equal(openDisputesCount({ nope: 1 }), undefined);
});

test("a blank verdict string does not count as resolved", () => {
  assert.equal(openDisputesCount([{ status: "open", verdict: "" }]), 1);
  assert.equal(openDisputesCount([{ status: "open", verdict: "   " }]), 1);
});
