import test from "node:test";
import assert from "node:assert/strict";

import {
  compactWallet,
  createOperatorActivityFeed,
  listAlerts,
  listAuditEvents
} from "./operator-activity-feed.js";

const NOW = new Date("2026-06-06T12:00:00.000Z").getTime();

test("compactWallet preserves short values and compacts long wallets", () => {
  assert.equal(compactWallet(""), "system");
  assert.equal(compactWallet("0xabc"), "0xabc");
  assert.equal(compactWallet("0x1234567890abcdef"), "0x1234...cdef");
});

test("listAuditEvents builds run, policy, and capability lifecycle events", async () => {
  const events = await listAuditEvents({
    defaultVerifierAddress: "0xVerifierAddress00000000000000000000000000000000",
    limit: 20,
    listPolicies: () => [
      {
        id: "policy-1",
        tag: "claim/sample@v1",
        state: "Pending",
        lastChange: {
          author: "fd2e",
          at: "2026-06-06T11:00:00.000Z",
          text: "Policy proposed"
        }
      }
    ],
    now: () => NOW,
    operatorSigners: {
      fd2e: {
        role: "operator",
        addr: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519"
      }
    },
    service: {
      listRecentSessions: async () => [
        {
          sessionId: "session-1",
          jobId: "job-1",
          wallet: "0xWorker000000000000000000000000000000000000",
          chainJobId: "0xjobhash",
          status: "approved",
          createdAt: "2026-06-06T10:00:00.000Z",
          submittedAt: "2026-06-06T10:10:00.000Z",
          verifiedAt: "2026-06-06T10:20:00.000Z",
          submission: { ok: true },
          verification: { verdict: "approved" }
        }
      ]
    },
    stateStore: {
      listCapabilityGrants: async () => [
        {
          id: "grant-1",
          capabilities: ["jobs:claim", "jobs:submit"],
          issuedAt: "2026-06-06T09:00:00.000Z",
          issuedBy: "0xIssuer000000000000000000000000000000000000",
          subject: "0xSubject00000000000000000000000000000000000",
          scope: "wikipedia",
          status: "revoked",
          revokedAt: "2026-06-06T09:30:00.000Z",
          revokedBy: "0xRevoker0000000000000000000000000000000000",
          revokeNote: "rotated"
        }
      ]
    }
  });

  const actions = events.map((event) => event.action);
  assert.deepEqual(actions, [
    "policy.proposed",
    "verification.resolved",
    "session.submitted",
    "session.claimed",
    "capability.revoke",
    "capability.grant"
  ]);
  assert.equal(events.find((event) => event.action === "session.claimed").day, "today");
  assert.equal(events.find((event) => event.action === "policy.proposed").actor.address, "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519");
  assert.match(events.find((event) => event.action === "capability.revoke").summary, /rotated/u);
});

test("listAuditEvents tolerates capability store failures", async () => {
  const events = await listAuditEvents({
    limit: 20,
    listPolicies: () => [],
    now: () => NOW,
    service: { listRecentSessions: async () => [] },
    stateStore: {
      listCapabilityGrants: async () => {
        throw new Error("store unavailable");
      }
    }
  });

  assert.deepEqual(events, []);
});

test("listAlerts keeps dispute and pending-policy alerts before session alerts", async () => {
  const alerts = await listAlerts({
    limit: 3,
    listDisputes: async () => [
      {
        id: "dispute-1",
        sessionId: "session-disputed",
        stakedAmount: "3"
      }
    ],
    listPolicies: () => [
      {
        id: "policy-1",
        tag: "claim/sample@v1",
        state: "Pending",
        signersReq: 2
      }
    ],
    service: {
      listRecentSessions: async () => [
        { sessionId: "session-1", jobId: "job-1", status: "submitted" },
        { sessionId: "session-2", jobId: "job-2", status: "disputed" }
      ]
    }
  });

  assert.deepEqual(alerts.map((alert) => alert.id), [
    "alert-dispute-1",
    "alert-policy-1",
    "alert-session-session-1"
  ]);
  assert.equal(alerts[0].ctaHref, "/disputes");
  assert.equal(alerts[1].ctaHref, "/policies");
  assert.equal(alerts[2].ctaHref, "/runs");
});

test("createOperatorActivityFeed wires alert and audit dependencies", async () => {
  const feed = createOperatorActivityFeed({
    listDisputes: async () => [],
    listPolicies: () => [],
    now: () => NOW,
    service: {
      listRecentSessions: async () => [
        {
          sessionId: "session-1",
          jobId: "job-1",
          wallet: "0xWorker000000000000000000000000000000000000",
          createdAt: "2026-06-06T10:00:00.000Z",
          status: "submitted"
        }
      ]
    },
    stateStore: {}
  });

  assert.equal((await feed.listAuditEvents(5))[0].action, "session.claimed");
  assert.equal((await feed.listAlerts(5))[0].id, "alert-session-session-1");
});
