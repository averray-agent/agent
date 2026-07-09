import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPulseEvents,
  pulseKindForTopic,
  pulseToneForTopic,
  shortWallet,
} from "./pulse-adapter.js";

test("kind mapping follows the pulse filters", () => {
  assert.equal(pulseKindForTopic("account.job_stake_locked"), "stake");
  assert.equal(pulseKindForTopic("reputation.badge_minted"), "identity");
  assert.equal(pulseKindForTopic("escrow.job_claimed"), "runs");
  assert.equal(pulseKindForTopic("session.claimed"), "runs");
  assert.equal(pulseKindForTopic("system.provider_error"), "runs");
});

test("tone marks failures warn and completions accent", () => {
  assert.equal(pulseToneForTopic("escrow.dispute_opened"), "warn");
  assert.equal(pulseToneForTopic("system.listener_error"), "warn");
  assert.equal(pulseToneForTopic("reputation.badge_minted"), "accent");
  assert.equal(pulseToneForTopic("session.claimed"), "blue");
  assert.equal(pulseToneForTopic("escrow.job_claimed"), "neutral");
});

test("shortWallet truncates addresses and passes through labels", () => {
  assert.equal(
    shortWallet("0x10E82610BDFb7A4fC0d5E1c2E0694C810434214b"),
    "0x10E826…214b"
  );
  assert.equal(shortWallet(""), "—");
  assert.equal(shortWallet(undefined), "—");
  assert.equal(shortWallet("operator"), "operator");
});

test("buildPulseEvents is defensive about payload shapes", () => {
  const rows = buildPulseEvents([
    {
      topic: "escrow.job_claimed",
      data: { jobId: "job-7", worker: "0x10E82610BDFb7A4fC0d5E1c2E0694C810434214b" },
      id: "42",
      at: Date.UTC(2026, 6, 8, 22, 50, 7),
    },
    { topic: "reputation.updated", data: "not-an-object", at: Number.NaN },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "42");
  assert.equal(rows[0].kind, "runs");
  assert.equal(rows[0].address, "0x10E826…214b");
  assert.equal(rows[0].message, "ref job-7");
  assert.equal(rows[0].time, "22:50:07 UTC");
  assert.equal(rows[1].kind, "identity");
  assert.equal(rows[1].address, "—");
  assert.equal(rows[1].time, "—");
  assert.ok(rows[1].id.length > 0);
});

test("buildPulseEvents tolerates empty input", () => {
  assert.deepEqual(buildPulseEvents(undefined), []);
  assert.deepEqual(buildPulseEvents([]), []);
});
