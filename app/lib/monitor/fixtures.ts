// Hermes Handoff Monitor — fixture data for the M3 milestone.
//
// Until live data wiring lands in M4, the monitor page renders
// against these fixtures so we can see the full card vocabulary
// in action. Cards mirror the bundle's `data.jsx` 1:1, ported to
// TypeScript + the canonical card-types discriminated union.
//
// Once M4 ships, this file becomes test-only — Playwright snapshot
// tests will continue to render against it to lock the visual
// regression baseline.

import type { BoardCard } from "./card-types.js";

/** Eight live cards plus eleven done-history entries — the same
 *  mix the bundle's A1 (default rich-mix) artboard renders.
 */
export const FIXTURE_CARDS: BoardCard[] = [
  // ── Action-needed: the one card that needs Pascal RIGHT NOW ──
  {
    id: "agent #548",
    lane: "operator-review",
    type: "pr",
    agentType: "codex",
    title: "Allow operator override of agent claim-stake floor",
    summary:
      "2 changed files touch review-gated surfaces (workflow, ops). Hermes has done the code-level pre-check.",
    repo: "depre-dev/agent",
    branch: "codex/claim-stake-floor",
    freshness: 4,
    state: "fresh",
    risk: ["workflow", "config", "review-gated"],
    files: [
      { path: "agent/contracts/AgentAccountCore.sol", diff: "+18 -4", critical: true },
      { path: "ops/deploy.staging.yml", diff: "+12 -3", critical: true },
      { path: "docs/operator/claim-stake.md", diff: "+34 -0", critical: false },
    ],
    checks: { pass: 5, running: 1, fail: 0, pending: 0, total: 6 },
    verdict:
      "Hermes has already done the code-level pre-check. Operator decision: confirm the operational change, secret boundary, and rollback story are acceptable.",
    waitingOn: { actor: "operator", tone: "warn" },
    action: { kind: "operator-review", primary: "Approve & merge", secondary: "Send back to Codex" },
    isAction: true,
  },

  // ── Hermes checking — a PR mid pre-check ──
  {
    id: "agent #549",
    lane: "hermes-checking",
    type: "pr",
    agentType: "claude",
    title: "Refactor handoff verifier for batched signatures",
    summary: "CI in flight · 4/7 checks green · Hermes parsing diff against review-gated globs",
    repo: "depre-dev/agent",
    freshness: 12,
    state: "fresh",
    risk: ["contracts"],
    checks: { pass: 4, running: 3, fail: 0, pending: 0, total: 7 },
    waitingOn: { actor: "CI", tone: "info" },
    files: [
      { path: "agent/contracts/HandoffVerifier.sol", diff: "+62 -38", critical: true },
      { path: "agent/tests/handoff.spec.ts", diff: "+44 -2", critical: false },
    ],
  },

  // ── Codex needed (proposed but un-picked) ──
  {
    id: "task starter-coding-014",
    lane: "codex-needed",
    type: "task",
    agentType: "hermes",
    title: "Reduce audit-log noise when policy auto-applies",
    summary:
      "Hermes proposed a bounded Codex task after seeing 14 near-identical entries on policy ops/schema-dual-sign. Operator approval to dispatch.",
    repo: "depre-dev/agent",
    freshness: 38,
    state: "fresh",
    risk: ["quality"],
    waitingOn: { actor: "operator", tone: "info" },
    prompt:
      "Coalesce repeated policy-attach entries into a single rolled-up row with a count and a 'last applied' timestamp. Do not change the on-chain audit record.",
    action: { kind: "codex-approve", primary: "Dispatch to Codex", secondary: "Edit prompt" },
  },

  // ── Drafts (author hasn't finished) ──
  {
    id: "agent #550",
    lane: "drafts",
    type: "pr",
    agentType: "claude",
    title: "WIP: governance dispute UI — first draft of the operator dispute drawer",
    summary: "Draft on remote, 3 commits, no tests yet. Author still pushing — Hermes leaves it alone until marked ready.",
    repo: "depre-dev/agent",
    freshness: 27,
    state: "fresh",
    risk: ["ui-only"],
    isDraft: true,
    waitingOn: { actor: "author", tone: "neutral" },
    files: [],
  },

  // ── Browser mission (testbed) — runs inside Hermes checking lane ──
  {
    id: "mission browser-onboard-04",
    lane: "hermes-checking",
    type: "mission",
    agentType: "hermes",
    title: "Verify onboarding flow on staging.averray.com",
    summary:
      "Fresh agent · path: connect wallet → claim → first receipt. Confidence 0.81, blocker on step 3 (sign timeout).",
    repo: "depre-dev/site",
    branch: "staging",
    freshness: 9,
    state: "fresh",
    risk: ["testbed"],
    checks: { pass: 0, running: 1, fail: 0, pending: 0, total: 1 },
    waitingOn: { actor: "agent", tone: "info" },
    mission: {
      verdict: "PARTIAL",
      verdictTone: "warn",
      confidence: 0.81,
      latency: "2m 14s",
      target: "https://staging.averray.com/onboarding",
      seed: "fresh · no memory",
      runs: 4,
      successScore: 7,
      clarityScore: 6,
      latencyScore: 8,
      path: [
        { n: 1, status: "ok", desc: "Loaded onboarding page", lat: "320ms" },
        { n: 2, status: "ok", desc: "Clicked Connect wallet", lat: "120ms" },
        { n: 3, status: "warn", desc: "Waited 12s for Sign message modal — eventually appeared, but no spinner during the gap", lat: "12.4s" },
        { n: 4, status: "ok", desc: "Signed, redirected to Claim step", lat: "480ms" },
        { n: 5, status: "warn", desc: "Receipt pending status with no indicator of polling cadence — would have given up at ~8s", lat: "7.2s" },
        { n: 6, status: "ok", desc: "Receipt rendered, page reached done state", lat: "210ms" },
      ],
      blockers: [
        { head: "Sign-message modal latency", body: "Modal opens ~12s after click. No spinner, no skeleton, no copy explaining the wait. Fresh agent almost abandoned at the 10s mark; a real user would have refreshed." },
        { head: "Receipt poll has no visible cadence", body: "Receipt pending sits with no progress signal. Confidence dropped because the agent couldn't tell whether the page was alive. Recommend a polling… caption or skeleton bar." },
      ],
      evidence: [
        { kind: "screenshot", label: "step-3-modal-gap.png", href: "#" },
        { kind: "screenshot", label: "step-5-receipt-no-spinner.png", href: "#" },
        { kind: "trace", label: "browser-trace · 2m 14s", href: "#" },
        { kind: "console", label: "console-log · 3 warnings", href: "#" },
      ],
      mutationBoundary:
        "Read-only mission. No transactions submitted; staging wallet never signed a real transfer. Mutation boundary held.",
      recommendations: [
        "Add a spinner + 3-line copy explaining the wait inside the Sign-message modal trigger.",
        "Replace 'Receipt pending' with a progressive caption ('checking indexer · 1/3 confirms').",
      ],
    },
  },

  // ── Release queue ──
  {
    id: "agent #547",
    lane: "release-queue",
    type: "pr",
    agentType: "codex",
    title: "Docs: add receipt drawer screenshots + glossary for cosigner",
    summary: "Merge-ready · waiting on branch-protection · 6/6 checks green · low-risk (docs only).",
    repo: "depre-dev/site",
    freshness: 22,
    state: "fresh",
    risk: ["docs"],
    checks: { pass: 6, running: 0, fail: 0, pending: 0, total: 6 },
    waitingOn: { actor: "branch-protection", tone: "neutral" },
    files: [],
  },

  // ── Deploying ──
  {
    id: "deploy #246",
    lane: "deploying",
    type: "deploy",
    agentType: "ext",
    title: "Post-merge verify · #544 Wire XCM settlement path to v3 router",
    summary: "Verification 3/5 · awaiting XCM relay confirmation and indexer settle. Last refresh 11s ago.",
    repo: "depre-dev/agent",
    freshness: 2,
    state: "fresh",
    risk: ["indexer", "xcm"],
    checks: { pass: 3, running: 2, fail: 0, pending: 0, total: 5 },
    waitingOn: { actor: "relay", tone: "info" },
    deployId: "#246",
    verification: { current: 3, total: 5, label: "indexer settle" },
  },

  // ── Stale needs-attention (>2h) — archive hint visible ──
  {
    id: "agent #542",
    lane: "needs-attention",
    type: "pr",
    agentType: "codex",
    title: "Bump indexer dep — substrate-api-sidecar 19.3 → 19.5",
    summary: "Author marked ready 2d ago. No reviewer assigned. Hermes flagged for triage.",
    repo: "depre-dev/agent",
    freshness: 2880,
    state: "stale",
    risk: ["deps", "indexer"],
    waitingOn: { actor: "operator", tone: "neutral" },
    archiveHint: true,
    isAction: true,
    files: [],
  },

  // ── Done / release history — keep a representative slice ──
  ...buildDoneHistory(),
];

function buildDoneHistory(): BoardCard[] {
  const titles = [
    "1 changed file touches secrets, contracts, or DB migrations",
    "2 changed files touch review-gated surfaces (workflow, ops)",
    "Ready to merge · docs, config, tests",
    "Ready to merge · docs",
    "3 changed files touch blockchain/XCM settlement",
  ];
  const numbers = [546, 545, 544, 543, 541, 540, 539, 538, 537, 535, 532];
  return numbers.map((n, i): BoardCard => ({
    id: `agent #${n}`,
    lane: "done",
    type: "done",
    agentType: i % 2 === 0 ? "codex" : "claude",
    title: titles[i % titles.length] as string,
    summary: "",
    repo: "depre-dev/agent",
    freshness: 60 * (2 + i * 1.7),
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "neutral" },
    closedAt: "5/27/2026 · 4:28 PM",
    mergeStatus: "MERGED",
  } as BoardCard));
}

/**
 * Cards demonstrating the degraded states (failed-fetch and
 * source-offline). Excluded from FIXTURE_CARDS by default — the
 * happy path is what the M3 page demos. M10 surfaces these when
 * the degraded-mode UI lands.
 */
export const DEGRADED_FIXTURE_CARDS: BoardCard[] = [
  {
    id: "agent #555",
    lane: "hermes-checking",
    type: "pr",
    agentType: "codex",
    title: "Bump XCM router to v3.1 — fixes settlement timeout on Asset Hub",
    summary: "",
    repo: "depre-dev/agent",
    freshness: 18,
    state: "failed-fetch",
    risk: ["contracts"],
    waitingOn: { actor: "CI", tone: "info" },
    files: [],
  },
  {
    id: "mission browser-claim-09",
    lane: "hermes-checking",
    type: "mission",
    agentType: "hermes",
    title: "Verify claim flow on staging — third pass after the modal fix",
    summary: "",
    repo: "depre-dev/site",
    freshness: 42,
    state: "source-offline",
    risk: ["testbed"],
    waitingOn: { actor: "agent", tone: "neutral" },
    mission: {
      verdict: "FAILED",
      verdictTone: "fail",
      confidence: 0,
      latency: "—",
      target: "https://staging.averray.com/claim",
      seed: "fresh · no memory",
      runs: 0,
      successScore: 0,
      clarityScore: 0,
      latencyScore: 0,
      path: [],
      blockers: [],
      evidence: [],
      mutationBoundary: "Mission did not run — runner pool offline.",
      recommendations: [],
    },
  },
];
