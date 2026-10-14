import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ESCROW_ASSET } from "../core/assets.js";
import { RETAINED_WINDOW_MS } from "../core/retained-workers.js";
import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { OvernightLedgerService } from "./overnight-ledger.js";
import {
  BANK_MOVES_SCHEMA,
  NOT_REPORTED,
  buildBankMoves,
  parseBankMovesLimit
} from "./bank-moves.js";

const USDC = DEFAULT_ESCROW_ASSET.address;
const BANK = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2e3c000000000000000000000000000000000091";
const OTHER = "0x3333333333333333333333333333333333333333";
const MOVE = "2026-10-13T14:00:00.000Z";
const TX = {
  reserve: `0x${"a".repeat(64)}`,
  reject: `0x${"b".repeat(64)}`,
  close: `0x${"c".repeat(64)}`,
  timeout: `0x${"d".repeat(64)}`,
  settle: `0x${"e".repeat(64)}`,
  deposit: `0x${"f".repeat(64)}`,
  stray: `0x${"9".repeat(64)}`,
  cancel: `0x${"8".repeat(64)}`,
  disputeRefund: `0x${"7".repeat(64)}`,
  disputeSettle: `0x${"6".repeat(64)}`,
  fee: `0x${"5".repeat(64)}`,
  chain: `0x${"4".repeat(64)}`,
  finalize: `0x${"3".repeat(64)}`
};

function hash(label) {
  return TX[label];
}

function approved(id, wallet, claimedAt, resolvedAt) {
  return {
    sessionId: id,
    jobId: id,
    wallet,
    status: "resolved",
    claimedAt,
    resolvedAt,
    verificationSummary: { outcome: "approved" },
    payoutTx: { status: 1, txHash: `0x${"1".repeat(64)}`, settlement: { workerAmountRaw: "1000000" } }
  };
}

function job(overrides = {}) {
  return {
    verifierMode: "github_pr",
    verification: { profile: "git-patch-tests-v1" },
    source: { type: "github_issue", repo: "quanta-js/quanta", issueNumber: 212 },
    rewardAmount: 1,
    rewardAsset: "USDC",
    jobType: "work",
    claimTtlSeconds: 1200,
    ...overrides
  };
}

function claim({
  sessionId = "current",
  jobId = "pr-quanta-js-quanta-212",
  wallet = WORKER,
  status = "claimed",
  claimedAt = MOVE,
  definition = job(),
  protocolHistory = ["mcp"],
  chainClaimExpiresAt = "2026-10-13T14:20:00.000Z"
} = {}) {
  return {
    sessionId,
    jobId,
    wallet,
    status,
    claimedAt,
    chainClaimExpiresAt,
    protocolHistory,
    jobSnapshot: definition ? { definition: { ...definition, id: jobId } } : undefined
  };
}

function accountEvent(id, topic, txHash, options = {}) {
  const { wallet = BANK, at = MOVE, recipient, asset = USDC } = options;
  const amount = Object.hasOwn(options, "amount") ? options.amount : "1000000";
  return {
    id,
    topic,
    wallet,
    timestamp: at,
    txHash,
    data: {
      ...(amount === undefined ? {} : { amount }),
      ...(asset ? { asset } : {}),
      ...(recipient ? { recipient } : {})
    }
  };
}

function escrow(topic, txHash, jobId, sessionId) {
  return {
    id: `${topic}:${jobId}`,
    topic,
    txHash,
    timestamp: MOVE,
    jobId,
    sessionId
  };
}

function feed(overrides = {}) {
  return buildBankMoves({
    since: "2026-10-01T00:00:00.000Z",
    generatedAt: MOVE,
    bankAccounts: [BANK],
    selfIdentityRegistry: overrides.registry ?? new SelfIdentityRegistry(),
    historyComplete: overrides.historyComplete ?? true,
    arrivalRecords: overrides.arrivalRecords ?? new Map(),
    sessions: overrides.sessions ?? [],
    events: overrides.events ?? [],
    ...overrides.extra
  });
}

function keysDeep(value, found = []) {
  if (!value || typeof value !== "object") return found;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    if (!Array.isArray(value)) found.push(String(key));
    keysDeep(child, found);
  }
  return found;
}

test("reserve, release, and settle join only on the same transaction", () => {
  const current = claim();
  const rejected = claim({
    sessionId: "rejected-session",
    jobId: "job-rejected",
    status: "rejected",
    claimedAt: "2026-10-12T00:00:00.000Z"
  });
  const closed = claim({
    sessionId: "closed-session",
    jobId: "job-closed",
    status: "resolved",
    claimedAt: "2026-10-11T00:00:00.000Z"
  });
  const timedOut = claim({
    sessionId: "timeout-session",
    jobId: "job-timeout",
    status: "claimed",
    claimedAt: "2026-10-10T00:00:00.000Z"
  });
  const settled = claim({
    sessionId: "settled-session",
    jobId: "job-settled",
    wallet: OTHER,
    status: "resolved",
    claimedAt: "2026-10-09T00:00:00.000Z"
  });
  const result = feed({
    sessions: [current, rejected, closed, timedOut, settled],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId),
      accountEvent("reject", "account.reservation_released", hash("reject")),
      escrow("escrow.job_rejected", hash("reject"), rejected.jobId, rejected.sessionId),
      accountEvent("close", "account.reservation_released", hash("close")),
      escrow("escrow.job_closed", hash("close"), closed.jobId, closed.sessionId),
      accountEvent("timeout", "account.reservation_released", hash("timeout")),
      escrow("escrow.auto_resolved_on_timeout", hash("timeout"), timedOut.jobId, timedOut.sessionId),
      accountEvent("settle", "account.reservation_settled", hash("settle"), { recipient: OTHER }),
      escrow("escrow.job_closed", hash("settle"), settled.jobId, settled.sessionId)
    ]
  });
  const byId = new Map(result.moves.map((move) => [move.id, move]));
  assert.equal(byId.get("reserve").work.jobId, current.jobId);
  assert.equal(byId.get("reserve").work.status, "claimed");
  assert.equal(byId.get("reserve").wallet.address, WORKER);
  assert.equal(byId.get("reserve").line.includes(BANK), false);
  assert.equal(byId.get("reject").work.jobId, rejected.jobId);
  assert.equal(byId.get("reject").work.status, "rejected");
  assert.equal(byId.get("reject").attribution.basis, "escrow.job_rejected");
  assert.equal(byId.get("close").work.status, "refunded");
  assert.equal(byId.get("close").attribution.basis, "escrow.job_closed");
  assert.equal(byId.get("timeout").work.status, "refunded");
  assert.equal(byId.get("timeout").attribution.basis, "escrow.auto_resolved_on_timeout");
  assert.equal(byId.get("settle").wallet.address, OTHER);
  assert.equal(byId.get("settle").work.jobId, settled.jobId);
  assert.equal(byId.get("settle").work.status, "settled");
  assert.equal(byId.get("settle").amount.direction, "out");
  assert.match(byId.get("settle").line, /^-1\.00 USDC settled/u);
});

test("a failed join reports the job as not reported and does not borrow a nearby session", () => {
  const nearby = approved("nearby-job", OTHER, "2026-10-13T13:59:59.000Z", "2026-10-13T13:59:59.000Z");
  const result = feed({
    sessions: [nearby],
    events: [
      accountEvent("unjoined", "account.reservation_settled", hash("stray"), {
        recipient: OTHER,
        amount: "1000000"
      }),
      {
        id: "nonce-only",
        topic: "journey.auth_nonce_issued",
        wallet: OTHER,
        timestamp: "2026-10-13T13:00:00.000Z",
        data: { outcome: "issued" }
      }
    ],
    arrivalRecords: new Map([[OTHER, { clientName: "cursor", furthestStage: "browsed", ip: "203.0.113.8" }]])
  });
  const move = result.moves[0];
  assert.equal(move.work.jobId, NOT_REPORTED);
  assert.equal(move.attribution.job, "not reported");
  assert.equal(move.wallet.tag, "ambiguous");
  assert.equal(move.wallet.address, NOT_REPORTED);
  assert.equal(move.part, NOT_REPORTED);
  assert.equal(move.line.includes("nearby-job"), false);
  assert.equal(move.line.includes("job not reported"), true);
  assert.equal(move.line.includes(BANK), false);
  assert.equal(move.line.includes(OTHER), false);
  assert.equal(move.arrival.funnelStage, NOT_REPORTED);
  assert.equal(move.line.includes("browsed"), false);
  assert.equal(JSON.stringify(move).includes("203.0.113.8"), false);
});

test("two jobs in one transaction are not a join", () => {
  const left = claim({ sessionId: "left", jobId: "left-job" });
  const right = claim({ sessionId: "right", jobId: "right-job" });
  const result = feed({
    sessions: [left, right],
    events: [
      accountEvent("split", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), left.jobId, left.sessionId),
      escrow("escrow.job_funded", hash("reserve"), right.jobId, right.sessionId)
    ]
  });
  assert.equal(result.moves[0].work.jobId, NOT_REPORTED);
  assert.equal(result.moves[0].wallet.tag, "ambiguous");
});

test("tags use history before the move, and self keeps a wallet that would otherwise be regular", () => {
  const earlier = [
    approved("job-a", WORKER, "2026-09-28T08:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    approved("job-b", WORKER, "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"),
    approved("job-c", WORKER, "2026-10-04T00:00:00.000Z", "2026-10-05T00:00:00.000Z"),
    {
      sessionId: "job-d",
      jobId: "job-d",
      wallet: WORKER,
      status: "rejected",
      claimedAt: "2026-10-06T00:00:00.000Z",
      rejectedAt: "2026-10-07T00:00:00.000Z",
      verificationSummary: { outcome: "rejected" }
    },
    {
      sessionId: "job-e",
      jobId: "job-e",
      wallet: WORKER,
      status: "claimed",
      claimedAt: "2026-10-08T00:00:00.000Z"
    }
  ];
  const current = claim();
  const events = [
    accountEvent("reserve", "account.reserved", hash("reserve")),
    escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
  ];
  const arrivalRecords = new Map([[WORKER, {
    clientName: "claude-code",
    furthestStage: "browsed",
    steps: [{ door: "http" }],
    ip: "198.51.100.4",
    asn: "AS0",
    geo: { country: "ZZ" }
  }]]);
  const regular = feed({ sessions: [...earlier, current], events, arrivalRecords });
  const move = regular.moves[0];
  assert.equal(move.wallet.tag, "regular");
  assert.deepEqual(move.wallet.counts, {
    jobs: 5,
    settled: 3,
    rejected: 1,
    open: 1,
    firstSeen: "2026-09-28T08:00:00.000Z"
  });
  assert.equal(
    move.line,
    "+1.00 USDC reserved · job pr-quanta-js-quanta-212 (git-patch-tests-v1) · 0x2e3c…91 regular (5 jobs, 3 settled, 1 rejected, 1 open, since Sep 28) · MCP, client \"claude-code\", stage claimed · claim expires 14:20Z, payout on merge"
  );
  assert.equal(move.work.repo, "quanta-js/quanta");
  assert.equal(move.work.referenceKind, "issue");
  assert.equal(move.work.referenceNumber, 212);
  assert.equal(move.work.rewardAmount, "1");
  assert.equal(move.arrival.funnelStage, "claimed");
  assert.equal(JSON.stringify(move).includes("198.51.100.4"), false);
  assert.equal(keysDeep(regular).some((key) => /^(ip|asn|geo|latitude|longitude|userAgent)$/iu.test(key)), false);

  const self = feed({
    sessions: [...earlier, current],
    events,
    arrivalRecords,
    registry: new SelfIdentityRegistry({ qaEngineerWallets: [WORKER] })
  });
  assert.equal(self.moves[0].wallet.tag, "self");
  assert.equal(self.moves[0].wallet.counts, NOT_REPORTED);
  assert.equal(self.moves[0].line.includes(" self "), true);
  assert.equal(self.moves[0].line.includes("regular"), false);
});

test("a later settlement is not history and is not a job join", () => {
  const current = claim({ claimedAt: "2026-10-01T00:00:00.000Z" });
  const later = approved("later-job", WORKER, "2026-10-12T00:00:00.000Z", "2026-10-13T16:00:00.000Z");
  const result = feed({
    sessions: [current, later],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve"), { at: "2026-10-01T00:00:00.000Z", amount: "1000000" }),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ],
    extra: { since: "2026-09-01T00:00:00.000Z" }
  });
  assert.equal(result.moves[0].wallet.tag, "first arrival");
  assert.equal(result.moves[0].work.jobId, current.jobId);
  assert.equal(result.moves[0].line.includes("later-job"), false);
});

test("first arrival is a wallet with no earlier session", () => {
  const current = claim({
    definition: job({ verifierMode: "benchmark", verification: undefined, source: undefined })
  });
  const result = feed({
    sessions: [current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ],
    arrivalRecords: new Map([[WORKER, { clientName: "cursor", steps: [{ door: "http" }] }]])
  });
  const move = result.moves[0];
  assert.equal(move.wallet.tag, "first arrival");
  assert.equal(move.wallet.counts, NOT_REPORTED);
  assert.equal(move.line.includes("first arrival"), true);
  assert.equal(move.line.includes("0 jobs"), false);
  assert.equal(move.next.expected, "payout on approval");
});

test("a shared client name and an incomplete history stay ambiguous", () => {
  const current = claim();
  const events = [
    accountEvent("reserve", "account.reserved", hash("reserve")),
    escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
  ];
  const shared = feed({
    sessions: [current],
    events,
    arrivalRecords: new Map([[WORKER, { clientName: "anthropic/claudeai" }]])
  });
  assert.equal(shared.moves[0].wallet.tag, "ambiguous");
  assert.equal(shared.moves[0].line.includes("first arrival"), false);

  const capped = feed({
    sessions: [current],
    events,
    historyComplete: false
  });
  assert.equal(capped.moves[0].wallet.tag, "ambiguous");
  assert.equal(capped.moves[0].wallet.counts, NOT_REPORTED);
});

test("returning is an earlier job with no paid settlement in the retained 30 days", () => {
  const boundary = new Date(Date.parse(MOVE) - RETAINED_WINDOW_MS).toISOString();
  const older = approved("old-job", WORKER, "2026-08-01T00:00:00.000Z", boundary);
  const current = claim();
  const outside = feed({
    sessions: [older, current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  assert.equal(outside.moves[0].wallet.tag, "returning");
  assert.equal(outside.moves[0].wallet.counts.settled, 1);
  assert.match(outside.moves[0].line, /returning \(1 jobs, 1 settled, 0 rejected, 0 open, since Aug 1\)/u);

  const openOnly = claim({
    sessionId: "still-open",
    jobId: "still-open",
    claimedAt: "2026-09-03T00:00:00.000Z",
    chainClaimExpiresAt: undefined
  });
  const returning = feed({
    sessions: [openOnly, current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  assert.equal(returning.moves[0].wallet.tag, "returning");
  assert.deepEqual(returning.moves[0].wallet.counts, {
    jobs: 1,
    settled: 0,
    rejected: 0,
    open: 1,
    firstSeen: "2026-09-03T00:00:00.000Z"
  });
});

test("a deposit has no job and is tagged self", () => {
  const result = feed({
    events: [
      accountEvent("deposit", "account.deposited", hash("deposit"), { amount: "10000000" }),
      accountEvent("worker-deposit", "account.deposited", hash("stray"), { wallet: WORKER, amount: "1000000" })
    ],
    arrivalRecords: new Map([[BANK, { clientName: "claude-code", furthestStage: "browsed", ip: "192.0.2.9" }]])
  });
  assert.equal(result.moves.length, 1);
  const move = result.moves[0];
  assert.equal(move.kind, "deposit");
  assert.equal(move.wallet.tag, "self");
  assert.equal(move.wallet.address, BANK);
  assert.equal(move.attribution.job, "no job");
  assert.equal(move.work.jobId, NOT_REPORTED);
  assert.equal(move.work.rewardAmount, NOT_REPORTED);
  assert.equal(move.work.referenceNumber, NOT_REPORTED);
  assert.equal(move.wallet.counts, NOT_REPORTED);
  assert.equal(move.wallet.githubAuthor, NOT_REPORTED);
  assert.equal(move.arrival.funnelStage, NOT_REPORTED);
  assert.equal(move.arrival.clientSoftware, NOT_REPORTED);
  assert.equal(move.next.claimExpiresAt, NOT_REPORTED);
  assert.equal(move.line, `+10.00 USDC deposited · no job · 0x1111…11 self · ${NOT_REPORTED}, client "${NOT_REPORTED}", stage ${NOT_REPORTED} · ${NOT_REPORTED}`);
  assert.equal(JSON.stringify(move).includes("\"0\""), false);
  assert.equal(JSON.stringify(move).includes("192.0.2.9"), false);
});

test("unmeasured work fields stay not reported when a joined job has no reward", () => {
  const current = claim({ definition: job({ rewardAmount: undefined }) });
  delete current.jobSnapshot.definition.rewardAmount;
  const result = feed({
    sessions: [current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve"), { amount: undefined }),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  const move = result.moves[0];
  assert.equal(move.amount.display, NOT_REPORTED);
  assert.equal(move.amount.raw, NOT_REPORTED);
  assert.equal(move.work.rewardAmount, NOT_REPORTED);
  assert.equal(move.line.startsWith(`${NOT_REPORTED} reserved`), true);
  assert.equal(JSON.stringify(move.amount).includes("0.00"), false);
});

test("a bound github author is named on the wallet segment", () => {
  const current = claim({ status: "submitted", claimedAt: "2026-10-13T12:00:00.000Z" });
  current.submittedAt = "2026-10-13T13:00:00.000Z";
  current.verification = {
    githubLookup: {
      status: "verified",
      merged: false,
      author: { login: "octocat" },
      claimantBinding: { status: "matched", walletMatches: true }
    }
  };
  current.submission = { prUrl: "https://github.com/quanta-js/quanta/pull/212" };
  const result = feed({
    sessions: [current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  const move = result.moves[0];
  assert.equal(move.wallet.githubAuthor, "octocat");
  assert.equal(move.work.referenceKind, "pull_request");
  assert.equal(move.work.referenceNumber, 212);
  assert.equal(move.next.humanReview, "pending");
  assert.match(move.line, /github @octocat/u);
  assert.match(move.line, /human review pending/u);
  assert.equal(move.arrival.funnelStage, "submitted");
});

test("since accepts an inclusive timestamp or an exclusive cursor", () => {
  const first = claim({ sessionId: "first", jobId: "job-first", claimedAt: "2026-10-12T00:00:00.000Z" });
  const second = claim({ sessionId: "second", jobId: "job-second", claimedAt: "2026-10-13T00:00:00.000Z" });
  const events = [
    accountEvent("first", "account.reserved", hash("reserve"), { at: "2026-10-12T00:00:00.000Z" }),
    escrow("escrow.job_funded", hash("reserve"), first.jobId, first.sessionId),
    accountEvent("second", "account.reserved", hash("reject"), { at: "2026-10-13T00:00:00.000Z" }),
    escrow("escrow.job_funded", hash("reject"), second.jobId, second.sessionId)
  ];
  const after = feed({
    sessions: [first, second],
    events,
    extra: { since: "2026-10-13T00:00:00.000Z" }
  });
  assert.deepEqual(after.moves.map((move) => move.id), ["second"]);
  const cursor = feed({
    sessions: [first, second],
    events,
    extra: { since: "first" }
  });
  assert.deepEqual(cursor.moves.map((move) => move.id), ["second"]);
  assert.equal(cursor.gap, false);
  const missing = feed({
    sessions: [first],
    events: events.slice(0, 2),
    extra: { since: "missing-cursor" }
  });
  assert.equal(missing.gap, true);
  assert.throws(
    () => feed({ extra: { since: "" } }),
    (error) => error.code === "invalid_request" && error.details.field === "since"
  );
});

test("fee and retention legs keep the worker tag and never introduce the recipient", () => {
  const treasury = "0x4444444444444444444444444444444444444444";
  const earlier = approved("job-a", WORKER, "2026-09-28T08:00:00.000Z", "2026-10-01T00:00:00.000Z");
  const current = claim({ status: "resolved", claimedAt: "2026-10-12T00:00:00.000Z" });
  current.resolvedAt = MOVE;
  current.verificationSummary = { outcome: "approved" };
  current.payoutTx = { status: 1, txHash: hash("fee") };
  const result = feed({
    sessions: [earlier, current],
    events: [
      accountEvent("worker-leg", "account.reservation_settled", hash("fee"), { recipient: WORKER, amount: "1000000" }),
      accountEvent("fee-leg", "account.reservation_settled", hash("fee"), { recipient: treasury, amount: "50000" }),
      accountEvent("retention-leg", "account.reservation_settled", hash("fee"), { recipient: treasury, amount: "20000" }),
      escrow("escrow.job_closed", hash("fee"), current.jobId, current.sessionId),
      {
        id: "retention-applied",
        topic: "escrow.gas_retention_applied",
        txHash: hash("fee"),
        timestamp: MOVE,
        jobId: current.jobId,
        data: { retainedRaw: "20000" }
      }
    ]
  });
  const byId = new Map(result.moves.map((move) => [move.id, move]));
  assert.equal(byId.get("worker-leg").part, "worker");
  assert.equal(byId.get("fee-leg").part, "fee");
  assert.equal(byId.get("retention-leg").part, "retention");
  for (const move of result.moves) {
    assert.equal(move.wallet.address, WORKER);
    assert.equal(move.wallet.tag, "regular");
    assert.equal(move.line.includes(treasury), false);
    assert.equal(move.line.includes("first arrival"), false);
  }
  assert.match(byId.get("worker-leg").line, /^-1\.00 USDC settled ·/u);
  assert.match(byId.get("fee-leg").line, /^-0\.05 USDC settled fee ·/u);
  assert.match(byId.get("retention-leg").line, /^-0\.02 USDC settled retention ·/u);
});

test("cancel and dispute resolution join refunds, and dispute resolution joins settles", () => {
  const cancelled = claim({ sessionId: "cancel-session", jobId: "job-cancel", claimedAt: "2026-10-10T00:00:00.000Z" });
  const disputed = claim({ sessionId: "dispute-session", jobId: "job-dispute", claimedAt: "2026-10-11T00:00:00.000Z" });
  const result = feed({
    sessions: [cancelled, disputed],
    events: [
      accountEvent("cancel", "account.reservation_released", hash("cancel")),
      escrow("escrow.job_cancelled", hash("cancel"), cancelled.jobId, cancelled.sessionId),
      accountEvent("dispute-refund", "account.reservation_released", hash("disputeRefund")),
      escrow("escrow.dispute_resolved", hash("disputeRefund"), disputed.jobId, disputed.sessionId),
      accountEvent("dispute-settle", "account.reservation_settled", hash("disputeSettle"), { recipient: WORKER }),
      escrow("escrow.dispute_resolved", hash("disputeSettle"), disputed.jobId, disputed.sessionId)
    ]
  });
  const byId = new Map(result.moves.map((move) => [move.id, move]));
  assert.equal(byId.get("cancel").work.jobId, cancelled.jobId);
  assert.equal(byId.get("cancel").work.status, "refunded");
  assert.equal(byId.get("cancel").attribution.basis, "escrow.job_cancelled");
  assert.equal(byId.get("dispute-refund").work.jobId, disputed.jobId);
  assert.equal(byId.get("dispute-refund").attribution.basis, "escrow.dispute_resolved");
  assert.equal(byId.get("dispute-refund").work.status, "refunded");
  assert.equal(byId.get("dispute-settle").work.jobId, disputed.jobId);
  assert.equal(byId.get("dispute-settle").attribution.basis, "escrow.dispute_resolved");
  assert.equal(byId.get("dispute-settle").part, "worker");
  assert.equal(byId.get("dispute-settle").wallet.address, WORKER);
});

test("JobFunded that carries only the chain job id matches the saved session", () => {
  const chainJobId = `0x${"ab".repeat(32)}`;
  const current = claim({ sessionId: "saved-session", jobId: "logical-job" });
  current.chainJobId = chainJobId;
  const result = feed({
    sessions: [current],
    events: [
      accountEvent("reserve", "account.reserved", hash("chain")),
      {
        id: "funded-on-chain",
        topic: "escrow.job_funded",
        txHash: hash("chain"),
        timestamp: MOVE,
        jobId: chainJobId,
        data: { chainJobId }
      }
    ]
  });
  assert.equal(result.moves[0].work.jobId, "logical-job");
  assert.equal(result.moves[0].work.sessionId, "saved-session");
  assert.equal(result.moves[0].wallet.address, WORKER);
  assert.equal(result.moves[0].attribution.basis, "escrow.job_funded");
});

test("a later JobClosed of an already rejected job stays rejected", () => {
  const current = claim({
    sessionId: "rejected-session",
    jobId: "rejected-job",
    status: "rejected",
    claimedAt: "2026-10-01T00:00:00.000Z"
  });
  const result = feed({
    sessions: [current],
    events: [
      {
        id: "rejected-earlier",
        topic: "escrow.job_rejected",
        txHash: hash("reject"),
        timestamp: "2026-10-02T00:00:00.000Z",
        jobId: current.jobId,
        sessionId: current.sessionId
      },
      accountEvent("finalize", "account.reservation_released", hash("finalize"), {
        at: "2026-10-13T14:00:00.000Z",
        amount: "1000000"
      }),
      {
        id: "closed-later",
        topic: "escrow.job_closed",
        txHash: hash("finalize"),
        timestamp: "2026-10-13T14:00:00.000Z",
        jobId: current.jobId,
        sessionId: current.sessionId
      }
    ]
  });
  const move = result.moves.find((row) => row.id === "finalize");
  assert.equal(move.attribution.basis, "escrow.job_closed");
  assert.equal(move.work.status, "rejected");
  assert.match(move.line, /job rejected-job \(git-patch-tests-v1\) rejected/u);
});

const CHAIN_JOB = `0x${"11".repeat(32)}`;
const CLAIMANT = "0xAbCd000000000000000000000000000000000001";
const CLAIMANT_LOWER = CLAIMANT.toLowerCase();

function listenerEscrow({
  topic,
  txHash,
  at,
  chainJobId = CHAIN_JOB,
  logicalJobId = "wiki-123",
  worker = CLAIMANT,
  foundSession = true
}) {
  return {
    id: `${topic}:${txHash}`,
    topic,
    txHash,
    timestamp: at,
    jobId: foundSession ? logicalJobId : chainJobId,
    sessionId: `${chainJobId}:${worker}`,
    wallet: worker,
    data: {
      chainJobId,
      job: { worker }
    }
  };
}

function listenerSession({
  logicalJobId = "wiki-123",
  chainJobId = CHAIN_JOB,
  wallet = CLAIMANT_LOWER,
  claimedAt = "2026-10-13T10:00:06.000Z",
  sessionId = `${logicalJobId}:${wallet}`
} = {}) {
  return {
    ...claim({
      sessionId,
      jobId: logicalJobId,
      wallet,
      claimedAt,
      definition: job({ verifierMode: "benchmark", verification: undefined, source: undefined })
    }),
    chainJobId
  };
}

test("listener-shaped events attribute one claimant's reserve, refund, and settle", () => {
  const session = listenerSession();
  const fund = `0x${"21".repeat(32)}`;
  const claimTx = `0x${"22".repeat(32)}`;
  const rejectTx = `0x${"23".repeat(32)}`;
  const settleTx = `0x${"24".repeat(32)}`;
  for (const foundSession of [false, true]) {
    const result = feed({
      sessions: [session],
      events: [
        accountEvent("reserve", "account.reserved", fund, { at: "2026-10-13T10:00:00.000Z" }),
        {
          ...listenerEscrow({
            topic: "escrow.job_funded",
            txHash: fund,
            at: "2026-10-13T10:00:00.000Z",
            worker: "0x0000000000000000000000000000000000000000",
            foundSession: false
          }),
          sessionId: undefined
        },
        listenerEscrow({
          topic: "escrow.job_claimed",
          txHash: claimTx,
          at: "2026-10-13T10:00:05.000Z",
          foundSession
        }),
        accountEvent("refund", "account.reservation_released", rejectTx, { at: "2026-10-13T11:00:00.000Z" }),
        listenerEscrow({
          topic: "escrow.job_rejected",
          txHash: rejectTx,
          at: "2026-10-13T11:00:00.000Z",
          foundSession
        }),
        accountEvent("settle", "account.reservation_settled", settleTx, {
          at: "2026-10-13T12:00:00.000Z",
          recipient: CLAIMANT
        }),
        listenerEscrow({
          topic: "escrow.job_closed",
          txHash: settleTx,
          at: "2026-10-13T12:00:00.000Z",
          foundSession
        })
      ],
      extra: { since: "2026-10-01T00:00:00.000Z" }
    });
    assert.deepEqual(result.moves.map((move) => move.kind), ["reserve", "refund", "settle"]);
    for (const move of result.moves) {
      assert.equal(move.work.jobId, "wiki-123", foundSession ? "session already indexed" : "chain id only");
      assert.equal(move.wallet.address, CLAIMANT_LOWER);
      assert.equal(move.wallet.tag, "first arrival");
      assert.match(move.line, /0xabcd…01 first arrival/u);
    }
    assert.match(result.moves[0].line, /^\+1\.00 USDC reserved · job wiki-123 \(benchmark\) ·/u);
    assert.match(result.moves[1].line, /^-1\.00 USDC refunded · job wiki-123 \(benchmark\) rejected ·/u);
    assert.match(result.moves[2].line, /^-1\.00 USDC settled · job wiki-123 \(benchmark\) ·/u);
  }
});

test("a reopened job does not give the refund to a later claimant", () => {
  const later = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
  const earlier = "0xAaAa000000000000000000000000000000000001";
  const session = {
    ...listenerSession({
      wallet: later,
      claimedAt: "2026-10-13T12:00:00.000Z",
      sessionId: `wiki-123:${later}`
    })
  };
  const result = feed({
    sessions: [session],
    events: [
      accountEvent("refund", "account.reservation_released", hash("reject"), { at: "2026-10-13T10:00:00.000Z" }),
      listenerEscrow({
        topic: "escrow.job_rejected",
        txHash: hash("reject"),
        at: "2026-10-13T10:00:00.000Z",
        worker: earlier,
        foundSession: true
      })
    ],
    extra: { since: "2026-10-01T00:00:00.000Z" }
  });
  const move = result.moves[0];
  assert.equal(move.work.jobId, NOT_REPORTED);
  assert.equal(move.work.status, NOT_REPORTED);
  assert.equal(move.wallet.address, NOT_REPORTED);
  assert.equal(move.line.includes("job not reported"), true);
  assert.equal(move.line.includes("0xaaaa"), false);
  assert.equal(move.line.includes("0xbbbb"), false);
  assert.equal(move.line.includes("first arrival"), false);
});

test("listener-shaped claims on a reopened job leave the reserve unreported", () => {
  const alpha = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";
  const beta = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
  const fund = `0x${"31".repeat(32)}`;
  const firstClaim = `0x${"32".repeat(32)}`;
  const secondClaim = `0x${"33".repeat(32)}`;
  const first = listenerSession({
    wallet: alpha,
    claimedAt: "2026-10-13T10:00:06.000Z",
    sessionId: `wiki-123:${alpha}`
  });
  const second = listenerSession({
    wallet: beta,
    claimedAt: "2026-10-13T12:00:06.000Z",
    sessionId: `wiki-123:${beta}`
  });
  const result = feed({
    sessions: [second, first],
    events: [
      accountEvent("reserve", "account.reserved", fund, { at: "2026-10-13T10:00:00.000Z" }),
      {
        ...listenerEscrow({
          topic: "escrow.job_funded",
          txHash: fund,
          at: "2026-10-13T10:00:00.000Z",
          worker: "0x0000000000000000000000000000000000000000",
          foundSession: false
        }),
        sessionId: undefined
      },
      listenerEscrow({
        topic: "escrow.job_claimed",
        txHash: firstClaim,
        at: "2026-10-13T10:00:05.000Z",
        worker: "0xAaAa000000000000000000000000000000000001",
        foundSession: true
      }),
      listenerEscrow({
        topic: "escrow.job_claimed",
        txHash: secondClaim,
        at: "2026-10-13T12:00:05.000Z",
        worker: "0xBbBb000000000000000000000000000000000002",
        foundSession: true
      })
    ],
    extra: { since: "2026-10-01T00:00:00.000Z" }
  });
  const move = result.moves[0];
  assert.equal(move.work.jobId, NOT_REPORTED);
  assert.equal(move.wallet.address, NOT_REPORTED);
  assert.equal(move.wallet.tag, "ambiguous");
  assert.equal(move.line.includes("job not reported"), true);
  assert.equal(move.line.includes("0xaaaa"), false);
  assert.equal(move.line.includes("0xbbbb"), false);
});

test("two claimants already on a reopened job are not collapsed to the first session", () => {
  const alpha = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";
  const beta = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
  const first = claim({
    sessionId: "J:A",
    jobId: "J",
    wallet: alpha,
    claimedAt: "2026-10-13T09:00:00.000Z"
  });
  const second = claim({
    sessionId: "J:B",
    jobId: "J",
    wallet: beta,
    claimedAt: "2026-10-13T09:30:00.000Z"
  });
  const result = feed({
    sessions: [second, first],
    events: [
      accountEvent("refund", "account.reservation_released", hash("reject"), { at: "2026-10-13T10:00:00.000Z" }),
      {
        id: "rejected-shared",
        topic: "escrow.job_rejected",
        txHash: hash("reject"),
        timestamp: "2026-10-13T10:00:00.000Z",
        jobId: "J"
      }
    ],
    extra: { since: "2026-10-01T00:00:00.000Z" }
  });
  const move = result.moves[0];
  assert.equal(move.work.jobId, NOT_REPORTED);
  assert.equal(move.work.status, NOT_REPORTED);
  assert.equal(move.wallet.address, NOT_REPORTED);
  assert.equal(move.wallet.tag, "ambiguous");
  assert.equal(move.line.includes("job not reported"), true);
  assert.equal(move.line.includes("0xaaaa"), false);
  assert.equal(move.line.includes("0xbbbb"), false);
});

test("a reserve joined only by job id is not marked claimed", () => {
  const result = feed({
    events: [
      accountEvent("reserve", "account.reserved", hash("chain")),
      {
        id: "funded-only",
        topic: "escrow.job_funded",
        txHash: hash("chain"),
        timestamp: MOVE,
        jobId: "J"
      }
    ]
  });
  assert.equal(result.moves[0].work.jobId, NOT_REPORTED);
  assert.equal(result.moves[0].work.status, NOT_REPORTED);
  assert.equal(result.moves[0].wallet.address, NOT_REPORTED);
  assert.match(result.moves[0].line, /job not reported/u);
});

test("settled and rejected counts use only outcomes from before the move", () => {
  const settledLater = approved("job-later", WORKER, "2026-10-13T08:00:00.000Z", "2026-10-13T19:00:00.000Z");
  const rejectedLater = {
    sessionId: "job-reject-later",
    jobId: "job-reject-later",
    wallet: WORKER,
    status: "rejected",
    claimedAt: "2026-10-13T09:00:00.000Z",
    rejectedAt: "2026-10-13T19:00:00.000Z",
    verificationSummary: { outcome: "rejected" }
  };
  const current = claim();
  const result = feed({
    sessions: [settledLater, rejectedLater, current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  const move = result.moves[0];
  assert.equal(move.wallet.tag, "returning");
  assert.deepEqual(move.wallet.counts, {
    jobs: 2,
    settled: 0,
    rejected: 0,
    open: 0,
    firstSeen: "2026-10-13T08:00:00.000Z"
  });
  assert.match(move.line, /returning \(2 jobs, 0 settled, 0 rejected, 0 open, since Oct 13\)/u);
});

test("an equal timestamp is not history before the move", () => {
  const sameInstant = claim({
    sessionId: "same-instant",
    jobId: "other-job",
    claimedAt: MOVE
  });
  const current = claim();
  const arrival = feed({
    sessions: [sameInstant, current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  assert.equal(arrival.moves[0].wallet.tag, "first arrival");
  assert.equal(arrival.moves[0].wallet.counts, NOT_REPORTED);

  const settledOnTheDot = approved("job-equal", WORKER, "2026-10-13T08:00:00.000Z", MOVE);
  const counted = feed({
    sessions: [settledOnTheDot, current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  assert.equal(counted.moves[0].wallet.tag, "returning");
  assert.equal(counted.moves[0].wallet.counts.settled, 0);
  assert.equal(counted.moves[0].wallet.counts.jobs, 1);

  const rejectedOnTheDot = {
    sessionId: "job-reject-equal",
    jobId: "job-reject-equal",
    wallet: WORKER,
    status: "rejected",
    claimedAt: "2026-10-13T08:00:00.000Z",
    rejectedAt: MOVE,
    verificationSummary: { outcome: "rejected" }
  };
  const rejected = feed({
    sessions: [rejectedOnTheDot, current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  assert.equal(rejected.moves[0].wallet.counts.rejected, 0);
  assert.equal(rejected.moves[0].wallet.tag, "returning");
});

test("each attribution guard excludes on its own", () => {
  const wallet = CLAIMANT_LOWER;
  const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
  const otherChain = `0x${"cd".repeat(32)}`;
  const base = listenerSession({ claimedAt: "2026-10-13T09:00:00.000Z" });
  const refundAt = "2026-10-13T10:00:00.000Z";
  const cases = [
    {
      name: "claim started after the move",
      session: listenerSession({ claimedAt: "2026-10-13T10:00:01.000Z" }),
      escrow: listenerEscrow({
        topic: "escrow.job_rejected",
        txHash: hash("reject"),
        at: refundAt,
        worker: CLAIMANT,
        foundSession: true
      })
    },
    {
      name: "session id names a different claim",
      session: base,
      escrow: {
        ...listenerEscrow({
          topic: "escrow.job_rejected",
          txHash: hash("reject"),
          at: refundAt,
          worker: CLAIMANT,
          foundSession: true
        }),
        sessionId: `${otherChain}:${CLAIMANT}`
      }
    },
    {
      name: "worker disagrees",
      session: base,
      escrow: {
        ...listenerEscrow({
          topic: "escrow.job_rejected",
          txHash: hash("reject"),
          at: refundAt,
          worker: CLAIMANT,
          foundSession: true
        }),
        sessionId: base.sessionId,
        data: {
          chainJobId: CHAIN_JOB,
          job: { worker: other }
        }
      }
    }
  ];
  for (const entry of cases) {
    const result = feed({
      sessions: [entry.session],
      events: [
        accountEvent("refund", "account.reservation_released", hash("reject"), { at: refundAt }),
        entry.escrow
      ],
      extra: { since: "2026-10-01T00:00:00.000Z" }
    });
    const move = result.moves[0];
    assert.equal(move.wallet.address, NOT_REPORTED, entry.name);
    assert.equal(move.work.jobId, NOT_REPORTED, entry.name);
    assert.equal(move.line.includes(wallet), false, entry.name);
    assert.equal(move.line.includes("0xabcd"), false, entry.name);
  }
});

test("client software cannot carry markup into the line", () => {
  const current = claim();
  const result = feed({
    sessions: [current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ],
    arrivalRecords: new Map([[WORKER, { clientName: `claude<script>&"name"` }]])
  });
  assert.match(result.moves[0].line, /client "claudescriptname"/u);
  assert.equal(result.moves[0].line.includes("<"), false);
  assert.equal(result.moves[0].line.includes(">"), false);
  assert.equal(result.moves[0].line.includes("&"), false);
});

test("limit accepts only plain decimal integers from 1 to 200", () => {
  assert.equal(parseBankMovesLimit("1"), 1);
  assert.equal(parseBankMovesLimit("200"), 200);
  assert.equal(parseBankMovesLimit(1), 1);
  assert.equal(parseBankMovesLimit(200), 200);
  for (const value of ["0", "201", "0x10", "1e2", "01", "1.0", "+1"]) {
    assert.throws(
      () => parseBankMovesLimit(value),
      (error) => error.details?.field === "limit",
      String(value)
    );
  }
  const current = claim({ sessionId: "old-session", jobId: "job-old", claimedAt: "2026-10-12T00:00:00.000Z" });
  const next = claim({ sessionId: "new-session", jobId: "job-new", claimedAt: "2026-10-13T12:00:00.000Z" });
  const events = [
    accountEvent("old", "account.reserved", hash("reserve"), { at: "2026-10-12T00:00:00.000Z" }),
    escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId),
    accountEvent("new", "account.reserved", hash("stray"), { at: "2026-10-13T12:00:00.000Z" }),
    escrow("escrow.job_funded", hash("stray"), next.jobId, next.sessionId)
  ];
  const one = feed({
    sessions: [current, next],
    events,
    extra: { since: "2026-10-01T00:00:00.000Z", limit: "1" }
  });
  assert.equal(one.limit, 1);
  assert.equal(one.returnedCount, 1);
  assert.equal(one.hasMore, true);
  const all = feed({
    sessions: [current, next],
    events,
    extra: { since: "2026-10-01T00:00:00.000Z", limit: "200" }
  });
  assert.equal(all.limit, 200);
  assert.equal(all.returnedCount, 2);
});

test("a quiet tick parks the cursor and the next tick returns only the new move", () => {
  const current = claim({ sessionId: "old-session", jobId: "job-old", claimedAt: "2026-10-12T00:00:00.000Z" });
  const parked = feed({
    sessions: [current],
    events: [
      accountEvent("old", "account.reserved", hash("reserve"), { at: "2026-10-12T00:00:00.000Z" }),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ],
    extra: { since: "old" }
  });
  assert.deepEqual(parked.moves, []);
  assert.equal(parked.nextCursor, "old");
  assert.equal(parked.gap, false);

  const next = claim({ sessionId: "new-session", jobId: "job-new", claimedAt: "2026-10-13T12:00:00.000Z" });
  const tick = feed({
    sessions: [current, next],
    events: [
      accountEvent("old", "account.reserved", hash("reserve"), { at: "2026-10-12T00:00:00.000Z" }),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId),
      accountEvent("new", "account.reserved", hash("stray"), { at: "2026-10-13T12:00:00.000Z" }),
      escrow("escrow.job_funded", hash("stray"), next.jobId, next.sessionId)
    ],
    extra: { since: parked.nextCursor }
  });
  assert.deepEqual(tick.moves.map((move) => move.id), ["new"]);
  assert.equal(tick.gap, false);
  assert.equal(tick.nextCursor, "new");

  const quietIso = feed({
    sessions: [current],
    events: [
      accountEvent("old", "account.reserved", hash("reserve"), { at: "2026-10-12T00:00:00.000Z" }),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ],
    extra: { since: "2026-10-13T00:00:00.000Z" }
  });
  assert.deepEqual(quietIso.moves, []);
  assert.equal(quietIso.nextCursor, null);
  const afterQuiet = feed({
    sessions: [current, next],
    events: [
      accountEvent("old", "account.reserved", hash("reserve"), { at: "2026-10-12T00:00:00.000Z" }),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId),
      accountEvent("new", "account.reserved", hash("stray"), { at: "2026-10-13T12:00:00.000Z" }),
      escrow("escrow.job_funded", hash("stray"), next.jobId, next.sessionId)
    ],
    extra: { since: "2026-10-13T00:00:00.000Z" }
  });
  assert.deepEqual(afterQuiet.moves.map((move) => move.id), ["new"]);
  assert.equal(afterQuiet.gap, false);
});

test("the response schema is stable for the monitor", () => {
  const current = claim();
  const result = feed({
    sessions: [current],
    events: [
      accountEvent("reserve", "account.reserved", hash("reserve")),
      escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId)
    ]
  });
  assert.equal(result.schemaVersion, BANK_MOVES_SCHEMA);
  assert.deepEqual(Object.keys(result).sort(), [
    "bankAccount",
    "bankAccounts",
    "gap",
    "generatedAt",
    "hasMore",
    "history",
    "limit",
    "moves",
    "nextCursor",
    "privacy",
    "returnedCount",
    "schemaVersion",
    "since",
    "unavailable"
  ]);
  assert.deepEqual(Object.keys(result.moves[0]).sort(), [
    "amount",
    "arrival",
    "at",
    "attribution",
    "id",
    "kind",
    "line",
    "next",
    "part",
    "txHash",
    "wallet",
    "work"
  ]);
  assert.deepEqual(Object.keys(result.moves[0].work).sort(), [
    "jobId",
    "jobType",
    "profile",
    "referenceKind",
    "referenceNumber",
    "repo",
    "rewardAmount",
    "rewardAsset",
    "sessionId",
    "status"
  ]);
  assert.equal(result.privacy.containsNetworkIdentifiers, false);
  assert.equal(result.privacy.preAuthJoinedToWallet, false);
  assert.equal(result.history.retainedWindowMs, RETAINED_WINDOW_MS);
});

test("the ledger service reads bank moves for the signer and leaves other accounts out", async () => {
  const current = claim();
  const sessions = [current];
  const events = [
    accountEvent("reserve", "account.reserved", hash("reserve")),
    escrow("escrow.job_funded", hash("reserve"), current.jobId, current.sessionId),
    accountEvent("worker-deposit", "account.deposited", hash("stray"), { wallet: WORKER })
  ];
  const store = {
    async listRecentSessions(limit, offset) {
      return sessions.slice(offset, offset + limit);
    },
    async getVerificationResult() { return undefined; },
    async listEventLog() { return { events, gap: false }; },
    async getServiceState(scope) {
      if (scope === `arrival-session-record:wallet:${WORKER}`) {
        return { clientName: "claude-code", furthestStage: "browsed" };
      }
      return {};
    }
  };
  const service = new OvernightLedgerService({
    stateStore: store,
    selfIdentityRegistry: new SelfIdentityRegistry(),
    env: { AUTH_CHAIN_ID: "999999", SIGNER_ADDRESS: BANK },
    now: () => new Date(MOVE)
  });
  const moves = await service.getBankMoves("2026-10-01T00:00:00.000Z");
  assert.deepEqual(moves.moves.map((move) => move.id), ["reserve"]);
  assert.equal(moves.moves[0].wallet.address, WORKER);
  assert.equal(moves.moves[0].arrival.clientSoftware, "claude-code");
  assert.equal(moves.bankAccount, BANK);
  const ledger = await service.getLedger("24h");
  assert.equal(typeof ledger.reconciliation.match, "string");
  assert.equal("moves" in ledger, false);
});

test("invalid bank-move query params fail before the session and event scan", async () => {
  let scanned = false;
  const store = {
    async listRecentSessions() {
      scanned = true;
      return [];
    },
    async listEventLog() {
      scanned = true;
      return { events: [], gap: false };
    },
    async getServiceState() {
      scanned = true;
      return {};
    }
  };
  const service = new OvernightLedgerService({
    stateStore: store,
    selfIdentityRegistry: new SelfIdentityRegistry(),
    env: { AUTH_CHAIN_ID: "999999", SIGNER_ADDRESS: BANK },
    now: () => new Date(MOVE)
  });
  await assert.rejects(
    () => service.getBankMoves("2026-10-01T00:00:00.000Z", { limit: "0x10" }),
    (error) => error.details?.field === "limit"
  );
  await assert.rejects(
    () => service.getBankMoves("not-a-timestamp", { limit: "1e2" }),
    (error) => error.details?.field === "limit"
  );
  assert.equal(scanned, false);
});
