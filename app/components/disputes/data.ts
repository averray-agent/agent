import type { Dispute } from "./types";

// TODO(data): wire to useApi("/disputes") once the backend emits a
// dedicated list endpoint. Today the data shape is mine and needs to
// be negotiated with mcp-server before it replaces this fixture.
// Every value here is synthetic but shaped like production output.

export const DISPUTES: Dispute[] = [
  {
    id: "d_4e10c",
    runRef: "run-2739",
    openingReceipt: "r_4e10c",
    summary:
      "Signature on handoff payload did not verify against the claim-hash; stake frozen pending review.",
    origin: "signature",
    severity: "hard-stop",
    state: "open",
    opener: {
      handle: "verifier-2",
      address: "0x9A13…0cb2",
      initials: "V2",
      tone: "blue",
    },
    respondent: {
      handle: "coding-hand-3",
      address: "0x4F88AD…19c0",
      initials: "CH",
      tone: "clay",
    },
    reviewer: {
      handle: "you · operator-primary",
      address: "0xFd2E…6519",
      initials: "FD",
      tone: "sage",
    },
    stakeFrozen: 45,
    stakeBreakdown: { worker: 30, verifier: 10, treasury: 5 },
    openedAt: "14:02:09 UTC",
    windowSeconds: 30 * 60,
    windowElapsed: 12 * 60 + 18,
    evidence: [
      {
        label: "artifact_hash",
        worker: "0x7a0c…b11e",
        expected: "0x7a0c…b11e",
        match: "ok",
      },
      {
        label: "policy_ref",
        worker: "claim/handoff-sig@v2",
        expected: "claim/handoff-sig@v2",
        match: "ok",
      },
      {
        label: "signature.alg",
        worker: "secp256k1",
        expected: "ed25519",
        match: "fail",
        note: "policy v2 requires ed25519; payload used secp256k1",
      },
      {
        label: "signature.over",
        worker: "[payload_hash]",
        expected: "[payload_hash, prev_receipt]",
        match: "fail",
        note: "missing prev_receipt in signed fields",
      },
      {
        label: "ttl_seconds",
        worker: "210",
        expected: "180",
        match: "warn",
        note: "exceeds policy cap by 30s",
      },
      {
        label: "signer",
        worker: "0x4F88AD…19c0",
        expected: "0x4F88AD…19c0",
        match: "ok",
      },
    ],
    workerPayload: `{
  "kind": "handoff",
  "run": "run-2739",
  "artifact_hash": "0x7a0c…b11e",
  "signature": {
    "alg": "secp256k1",
    "over": ["payload_hash"],
    "ttl_seconds": 210
  },
  "signer": "0x4F88AD…19c0"
}`,
    expectedPayload: `{
  "kind": "handoff",
  "run": "run-2739",
  "artifact_hash": "0x7a0c…b11e",
  "signature": {
    "alg": "ed25519",
    "over": ["payload_hash", "prev_receipt"],
    "ttl_seconds": 180
  },
  "signer": "0x4F88AD…19c0"
}`,
    timeline: [
      {
        at: "14:02:09 UTC",
        label: "opened",
        body: "verifier-2 raised a dispute on run-2739 citing signature-alg mismatch.",
      },
      {
        at: "14:02:14 UTC",
        label: "stake.locked",
        body: "45 DOT frozen in AgentAccountCore pending verdict.",
        tone: "warn",
      },
      {
        at: "14:04:41 UTC",
        label: "badge.suspended",
        body: "coding-hand-3's coding-1 badge auto-suspended per badge/revoke-on-dispute@v1.",
      },
      {
        at: "14:06:02 UTC",
        label: "review.assigned",
        body: "Routed to operator-primary (you). Window 00:30:00 began.",
        tone: "accent",
      },
    ],
  },
  {
    id: "d_4e04e",
    runRef: "run-2736",
    openingReceipt: "r_4e04e",
    summary:
      "Co-signer has not attested within the policy window; settlement blocked until second signature.",
    origin: "co-sign-missing",
    severity: "gating",
    state: "under-review",
    opener: {
      handle: "ops-migrator-1",
      address: "0xB2C7E1…ad14",
      initials: "OM",
      tone: "ink",
    },
    respondent: {
      handle: "operator-primary",
      address: "0xFd2E…6519",
      initials: "FD",
      tone: "sage",
    },
    reviewer: {
      handle: "you · operator-primary",
      address: "0xFd2E…6519",
      initials: "FD",
      tone: "sage",
    },
    stakeFrozen: 25,
    stakeBreakdown: { worker: 12.5, verifier: 7.5, treasury: 5 },
    openedAt: "13:52:08 UTC",
    windowSeconds: 30 * 60,
    windowElapsed: 22 * 60 + 40,
    evidence: [
      {
        label: "policy_ref",
        worker: "ops/schema-dual-sign@v4",
        expected: "ops/schema-dual-sign@v4",
        match: "ok",
      },
      {
        label: "primary_signer",
        worker: "0xFd2E…6519",
        expected: "0xFd2E…6519",
        match: "ok",
      },
      {
        label: "co_signer",
        worker: "—",
        expected: "one-of [0x9A13…, 0xC8F1…]",
        match: "fail",
        note: "no co-sign received inside 15-minute window",
      },
      {
        label: "schema.version",
        worker: "users_v2.1",
        expected: "users_v2.x",
        match: "ok",
      },
    ],
    workerPayload: `{
  "kind": "settle.request",
  "run": "run-2736",
  "policy": "ops/schema-dual-sign@v4",
  "signers": ["0xFd2E…6519"],
  "window_seconds": 900
}`,
    expectedPayload: `{
  "kind": "settle.request",
  "run": "run-2736",
  "policy": "ops/schema-dual-sign@v4",
  "signers": ["0xFd2E…6519", "<co-signer>"],
  "window_seconds": 900
}`,
    escalatedBy: {
      handle: "verifier-handler",
      address: "0x3E42…08d1",
      initials: "3E",
      tone: "blue",
    },
    escalatedAt: "14:11:02 UTC",
    timeline: [
      {
        at: "13:52:08 UTC",
        label: "opened",
        body: "ops-migrator-1 flagged missing co-sign on settlement request.",
      },
      {
        at: "13:52:20 UTC",
        label: "stake.locked",
        body: "25 DOT frozen. Settlement paused.",
        tone: "warn",
      },
      {
        at: "14:11:02 UTC",
        label: "escalated",
        body: "Window passed 70% with no co-sign; escalated to verifier-handler.",
        tone: "warn",
      },
      {
        at: "14:14:36 UTC",
        label: "review.resumed",
        body: "Operator-primary reopened for manual pass.",
        tone: "accent",
      },
    ],
  },
  {
    id: "d_4df10",
    runRef: "run-2711",
    openingReceipt: "r_4df10",
    summary:
      "Writer output cited external link in violation of writer-gov/cited@v3; upheld after review.",
    origin: "policy-violation",
    severity: "gating",
    state: "resolved",
    opener: {
      handle: "gov-review-2",
      address: "0x9A130C…b2f1",
      initials: "G2",
      tone: "muted",
    },
    respondent: {
      handle: "writer-gov-2",
      address: "0x5C17F0…4a90",
      initials: "W2",
      tone: "clay",
    },
    reviewer: {
      handle: "operator-primary",
      address: "0xFd2E…6519",
      initials: "FD",
      tone: "sage",
    },
    stakeFrozen: 11,
    stakeBreakdown: { worker: 7, verifier: 3, treasury: 1 },
    openedAt: "Apr 22 · 10:06 UTC",
    windowSeconds: 30 * 60,
    windowElapsed: 30 * 60,
    evidence: [
      {
        label: "policy_ref",
        worker: "writer-gov/cited@v3",
        expected: "writer-gov/cited@v3",
        match: "ok",
      },
      {
        label: "citations.external.allowed",
        worker: "true (1 external link present)",
        expected: "false",
        match: "fail",
        note: "Link to medium.com/@example violates policy",
      },
      {
        label: "citations.internal.per_300w",
        worker: "2",
        expected: "≥ 2",
        match: "ok",
      },
    ],
    workerPayload: `{
  "kind": "writer.output",
  "run": "run-2711",
  "artifact_hash": "0xbb41…a0c4",
  "citations": {
    "internal_per_300w": 2,
    "external_urls": ["medium.com/@example"]
  }
}`,
    expectedPayload: `{
  "kind": "writer.output",
  "run": "run-2711",
  "artifact_hash": "0xbb41…a0c4",
  "citations": {
    "internal_per_300w": 2,
    "external_urls": []
  }
}`,
    timeline: [
      {
        at: "Apr 22 · 10:06 UTC",
        label: "opened",
        body: "gov-review-2 raised policy violation on writer-gov/cited@v3.",
      },
      {
        at: "Apr 22 · 10:06 UTC",
        label: "stake.locked",
        body: "11 DOT frozen.",
        tone: "warn",
      },
      {
        at: "Apr 22 · 10:22 UTC",
        label: "verdict.upheld",
        body: "Operator-primary upheld the dispute. 7 DOT slashed from worker portion.",
        tone: "bad",
      },
      {
        at: "Apr 22 · 10:22 UTC",
        label: "receipt.signed",
        body: "r_4df10 signed; badge/revoke-on-dispute@v1 triggered automatically.",
        tone: "accent",
      },
    ],
    resolution: {
      decision: "uphold",
      destination: "slash-to-treasury",
      rationale:
        "External citation confirmed in artifact. Worker was warned on run-2698. Slash per policy; no further escalation.",
      at: "Apr 22 · 10:22 UTC",
      signer: {
        handle: "operator-primary",
        address: "0xFd2E…6519",
        initials: "FD",
        tone: "sage",
      },
    },
  },
];
