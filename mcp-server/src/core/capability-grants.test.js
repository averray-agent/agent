import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRevocation,
  buildCapabilityGrant,
  GRANT_STATUS,
  isGrantActive,
  isReservedCapability,
  mergeGrantCapabilities,
  projectGrant
} from "./capability-grants.js";
import { ValidationError } from "./errors.js";
import { listAllKnownCapabilities } from "../auth/capabilities.js";

const ADMIN = "0x1111111111111111111111111111111111111111";
const SUBJECT = "0x2222222222222222222222222222222222222222";
const KNOWN = listAllKnownCapabilities();

test("buildCapabilityGrant produces a stable id and active status", () => {
  const grant = buildCapabilityGrant(
    {
      subject: SUBJECT,
      capabilities: ["jobs:lifecycle", "policies:propose"],
      scope: "ops-bot",
      issuedAt: "2026-01-01T00:00:00.000Z",
      nonce: "test-nonce"
    },
    { knownCapabilities: KNOWN, issuerWallet: ADMIN }
  );
  assert.match(grant.id, /^grant-[a-f0-9]{12}$/u);
  assert.equal(grant.status, GRANT_STATUS.active);
  assert.deepEqual(grant.capabilities, ["jobs:lifecycle", "policies:propose"]);
  assert.equal(grant.subject, SUBJECT.toLowerCase());
  assert.equal(grant.issuedBy, ADMIN.toLowerCase());
  assert.equal(grant.scope, "ops-bot");
  assert.equal(grant.issuedAt, "2026-01-01T00:00:00.000Z");
});

test("buildCapabilityGrant rejects unknown capabilities (typo guard)", () => {
  assert.throws(
    () =>
      buildCapabilityGrant(
        { subject: SUBJECT, capabilities: ["jobs:nonsense"] },
        { knownCapabilities: KNOWN, issuerWallet: ADMIN }
      ),
    ValidationError
  );
});

test("buildCapabilityGrant rejects capability-management capabilities (no delegation chain)", () => {
  assert.throws(
    () =>
      buildCapabilityGrant(
        { subject: SUBJECT, capabilities: ["admin:capabilities:grant"] },
        { knownCapabilities: KNOWN, issuerWallet: ADMIN }
      ),
    ValidationError
  );
});

test("buildCapabilityGrant rejects malformed subject", () => {
  assert.throws(
    () =>
      buildCapabilityGrant(
        { subject: "not-a-wallet", capabilities: ["jobs:lifecycle"] },
        { knownCapabilities: KNOWN, issuerWallet: ADMIN }
      ),
    ValidationError
  );
});

test("buildCapabilityGrant rejects expiresAt before issuedAt", () => {
  assert.throws(
    () =>
      buildCapabilityGrant(
        {
          subject: SUBJECT,
          capabilities: ["jobs:lifecycle"],
          issuedAt: "2026-01-02T00:00:00.000Z",
          expiresAt: "2026-01-01T00:00:00.000Z"
        },
        { knownCapabilities: KNOWN, issuerWallet: ADMIN }
      ),
    ValidationError
  );
});

test("applyRevocation marks the grant revoked once and is idempotent", () => {
  const grant = buildCapabilityGrant(
    { subject: SUBJECT, capabilities: ["jobs:lifecycle"], nonce: "nonce-2" },
    { knownCapabilities: KNOWN, issuerWallet: ADMIN }
  );
  const first = applyRevocation(grant, { revokedBy: ADMIN, revokeNote: "rotated key" });
  assert.equal(first.alreadyRevoked, false);
  assert.equal(first.record.status, GRANT_STATUS.revoked);
  assert.equal(first.record.revokedBy, ADMIN.toLowerCase());
  assert.equal(first.record.revokeNote, "rotated key");
  assert.ok(first.record.revokedAt);

  const second = applyRevocation(first.record, { revokedBy: ADMIN });
  assert.equal(second.alreadyRevoked, true);
  assert.equal(second.record, first.record);
});

test("isGrantActive treats expired grants as inactive without mutating", () => {
  const past = "2020-01-01T00:00:00.000Z";
  const expired = {
    id: "grant-expired",
    status: GRANT_STATUS.active,
    capabilities: ["jobs:lifecycle"],
    issuedAt: past,
    expiresAt: past
  };
  assert.equal(isGrantActive(expired), false);

  const future = new Date(Date.now() + 60_000).toISOString();
  const live = {
    id: "grant-live",
    status: GRANT_STATUS.active,
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    expiresAt: future
  };
  assert.equal(isGrantActive(live), true);
});

test("mergeGrantCapabilities adds active grant capabilities to the base set", () => {
  const base = ["jobs:claim", "session:read"];
  const grants = [
    {
      id: "g1",
      status: GRANT_STATUS.active,
      capabilities: ["jobs:lifecycle", "policies:propose"],
      issuedAt: new Date().toISOString()
    },
    {
      id: "g2",
      status: GRANT_STATUS.revoked,
      capabilities: ["xcm:observe"],
      issuedAt: new Date().toISOString()
    }
  ];
  const merged = mergeGrantCapabilities(base, grants);
  assert.ok(merged.includes("jobs:lifecycle"));
  assert.ok(merged.includes("policies:propose"));
  assert.ok(merged.includes("jobs:claim"));
  assert.ok(merged.includes("session:read"));
  assert.ok(!merged.includes("xcm:observe"));
});

test("mergeGrantCapabilities never propagates capability-management capabilities", () => {
  const merged = mergeGrantCapabilities(
    ["jobs:claim"],
    [
      {
        id: "rogue",
        status: GRANT_STATUS.active,
        capabilities: ["admin:capabilities:grant"],
        issuedAt: new Date().toISOString()
      }
    ]
  );
  assert.ok(!merged.includes("admin:capabilities:grant"));
});

test("projectGrant returns a stable public shape", () => {
  const grant = buildCapabilityGrant(
    { subject: SUBJECT, capabilities: ["jobs:lifecycle"], nonce: "p" },
    { knownCapabilities: KNOWN, issuerWallet: ADMIN }
  );
  const projected = projectGrant(grant);
  assert.equal(projected.id, grant.id);
  assert.deepEqual(Object.keys(projected).sort(), [
    "capabilities",
    "id",
    "issuedAt",
    "issuedBy",
    "status",
    "subject"
  ].sort());
});

test("isReservedCapability flags only capability-management capabilities", () => {
  assert.equal(isReservedCapability("admin:capabilities:grant"), true);
  assert.equal(isReservedCapability("admin:capabilities:revoke"), true);
  assert.equal(isReservedCapability("admin:capabilities:read"), true);
  assert.equal(isReservedCapability("jobs:lifecycle"), false);
  assert.equal(isReservedCapability(""), false);
});
