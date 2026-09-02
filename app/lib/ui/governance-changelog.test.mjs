import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapabilityChangeEntries,
  buildPolicyChangeEntries,
} from "./governance-changelog.js";

test("buildPolicyChangeEntries returns newest policy before/after diffs", () => {
  const entries = buildPolicyChangeEntries([
    {
      id: "p-claim-deps-sec-only",
      tag: "claim/deps-sec-only@v4",
      scope: "claim",
      scopeLabel: "Claim",
      revision: 4,
      lastChange: {
        text: "Raised max-cvss ceiling.",
        at: "2026-05-28T12:00:00Z",
      },
      rule: {
        v3: '{ "max_cvss": 7.0 }',
        v4: '{ "max_cvss": 7.5 }',
      },
    },
    {
      id: "p-no-history",
      tag: "settle/receipt-before-payout@v1",
      revision: 1,
      lastChange: { text: "Initial.", at: "2026-05-29T12:00:00Z" },
      rule: { v1: "{}" },
    },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "policy:p-claim-deps-sec-only:v3->v4");
  assert.equal(entries[0].badge, "v3 -> v4");
  assert.match(entries[0].before, /7\.0/u);
  assert.match(entries[0].after, /7\.5/u);
});

test("buildCapabilityChangeEntries emits issue and revoke diffs newest-first", () => {
  const entries = buildCapabilityChangeEntries([
    {
      id: "grant-1",
      subject: "0x1111111111111111111111111111111111111111",
      scope: "ops-bot",
      capabilities: ["jobs:claim", "jobs:submit"],
      issuedAt: "2026-05-28T12:00:00Z",
      status: "revoked",
      revokedAt: "2026-05-29T12:00:00Z",
      revokeNote: "rotation complete",
    },
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "capability:grant-1:revoked");
  assert.equal(entries[0].badge, "revoked");
  assert.match(entries[0].before, /jobs:claim/u);
  assert.match(entries[0].after, /status: revoked/u);
  assert.equal(entries[1].id, "capability:grant-1:issued");
  assert.equal(entries[1].badge, "issued");
});
