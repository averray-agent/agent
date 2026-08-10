import assert from "node:assert/strict";
import test from "node:test";

import { classify } from "./check-secrets-calendar.mjs";

const NOW = new Date("2026-08-10T12:00:00Z");
const DEFAULTS = { default_warn_days: 7, fail_within_days: 1 };
const at = (entry) => classify(entry, NOW, DEFAULTS);

// The whole point of the split. On 2026-08-10 three rotation cadences fell due
// on one day and blocked every merge in the repo, for credentials that had not
// expired and cannot: an HMAC string, a password hash, and a hand-revoked vendor
// key. A cadence we chose ourselves must never be able to do that again.
test("an overdue rotation cadence warns and never fails the build", () => {
  const result = at({ rotate_by: "2026-07-01" });
  assert.equal(result.status, "warn");
  assert.match(result.reason, /nothing is broken/u);
});

test("a rotation cadence due today still only warns", () => {
  assert.equal(at({ rotate_by: "2026-08-10" }).status, "warn");
  assert.equal(at({ rotate_by: "2026-08-11" }).status, "warn");
});

// The other half: a real external deadline SHOULD block, because the
// alternative is an outage rather than untidiness.
test("a genuine expiry still fails once past", () => {
  const result = at({ expires_at: "2026-08-01" });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /EXPIRED/u);
});

test("a genuine expiry fails inside the fail window", () => {
  assert.equal(at({ expires_at: "2026-08-11" }).status, "fail");
});

test("a genuine expiry outside the warn window is ok", () => {
  assert.equal(at({ expires_at: "2026-12-01" }).status, "ok");
  assert.equal(at({ rotate_by: "2026-12-01" }).status, "ok");
});

// An entry that sets both is ambiguous about whether missing it is an outage,
// which is precisely the confusion this change removes. Refuse it loudly rather
// than silently preferring one.
test("setting both fields is an error, not a preference", () => {
  const result = at({ expires_at: "2026-12-01", rotate_by: "2026-12-01" });
  assert.equal(result.status, "error");
  assert.match(result.reason, /not both/u);
});

test("setting neither is an error", () => {
  assert.equal(at({ name: "nameless" }).status, "error");
});

test("never and TBD keep working on both fields", () => {
  assert.equal(at({ expires_at: "never" }).status, "skip");
  assert.equal(at({ rotate_by: "never" }).status, "skip");
  assert.equal(at({ expires_at: "TBD" }).status, "warn");
  assert.equal(at({ rotate_by: "TBD" }).status, "warn");
});

test("warn_days overrides apply to rotation cadences too", () => {
  assert.equal(at({ rotate_by: "2026-08-20" }).status, "ok");
  assert.equal(at({ rotate_by: "2026-08-20", warn_days: 30 }).status, "warn");
});

test("a malformed date is an error rather than a silent pass", () => {
  assert.equal(at({ rotate_by: "not-a-date" }).status, "error");
  assert.equal(at({ expires_at: 20260810 }).status, "error");
});
