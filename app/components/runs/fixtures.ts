/**
 * Shared demo data for the Runs surface.
 *
 * These fixtures are used when the live `/jobs` endpoint hasn't returned
 * yet (or returns an empty list) so the UI still reads correctly for
 * design reviews + offline dev. Everything here is shaped to match what
 * the backend adapters (`buildRunRows`, `buildGitHubContext`) emit for
 * live jobs, which keeps the swap-in cost low once the API is wired
 * everywhere.
 *
 * Kept in a separate module (rather than buried inside a page) so both
 * the main queue page and the standalone `/runs/detail/` fullscreen view
 * can fall back to the same content without duplicating ~300 lines of
 * demo records.
 */

import type { JobCardData } from "./JobCard";
import type { QueueFilterCount } from "./QueueBar";
import type { LifecycleStage } from "./LifecycleRail";
import type { RunRow } from "./RunQueueTable";

export const FIXTURE_RUN_ROWS: RunRow[] = [
  {
    id: "run-2749",
    title:
      "Document TypeScript validation helper API for external package consumers",
    jobMeta: "docs · T1",
    source: {
      type: "github_issue",
      repo: "oss-devsecblueprint/devsecblueprint",
      issueNumber: 110,
      issueUrl:
        "https://github.com/oss-devsecblueprint/devsecblueprint/issues/110",
      labels: ["documentation", "good first issue"],
      score: 82,
    },
    worker: { variant: "unclaimed", initials: "—", label: "unclaimed" },
    state: "ready",
    stake: "8.0",
    age: "00:01:04",
    lastEvent: "Ingested from GitHub",
    lastEventMeta: "14:29:55 · gh-ingest · score 82",
  },
  {
    id: "run-2741",
    title: "repo-sweep: deps/sec-only bump",
    jobMeta: "job-0421 · coding · T1",
    worker: { variant: "unclaimed", initials: "—", label: "unclaimed" },
    state: "ready",
    stake: "12.0",
    age: "00:11:42",
    ageStale: true,
    lastEvent: "Escrow funded",
    lastEventMeta: "14:20:25 · by 0x9A13…0cb2",
  },
  {
    id: "run-2742",
    title:
      "Fix flaky integration test: race condition when two workers claim within the same block window",
    jobMeta: "bugfix · T2",
    source: {
      type: "github_issue",
      repo: "paritytech/polkadot-sdk",
      issueNumber: 4812,
      issueUrl: "https://github.com/paritytech/polkadot-sdk/issues/4812",
      labels: ["bug", "flaky-test", "help wanted"],
      score: 74,
    },
    worker: { variant: "self", initials: "FD", label: "0xFd2E…6519", isSelf: true },
    state: "claimed",
    stake: "25.0",
    age: "00:08:14",
    lastEvent: "You claimed the run",
    lastEventMeta: "14:23:53 · tx 0x3f…c1",
  },
  {
    id: "run-2743",
    title: "schema-mig: users → users_v2",
    jobMeta: "job-0415 · ops · T3",
    worker: { variant: "a", initials: "OM", label: "0xB1aa…3e41" },
    state: "submitted",
    stake: "50.0",
    age: "00:06:02",
    lastEvent: "Evidence submitted · 14 files",
    lastEventMeta: "14:26:05 · hash 0x4e…b8",
  },
  {
    id: "run-2744",
    title: "handoff-sig verify: batch #214",
    jobMeta: "job-0414 · coding-hand · T2",
    worker: { variant: "b", initials: "CH", label: "0x2E94…7f02" },
    state: "disputed",
    stake: "40.0",
    age: "00:34:18",
    ageStale: true,
    lastEvent: "Signature mismatch on payload",
    lastEventMeta: "13:58:09 · by verifier-2",
  },
  {
    id: "run-2745",
    title: "docs-refresh: runbook v3.1",
    jobMeta: "job-0411 · writer-gov · T1",
    worker: { variant: "c", initials: "WG", label: "0xC7fE…9ab1" },
    state: "submitted",
    stake: "18.0",
    age: "00:04:47",
    lastEvent: "Verifier queued · semantic mode",
    lastEventMeta: "14:27:19 · r_4e0f8",
  },
  {
    id: "run-2746",
    title: "lint-sweep: packages/*",
    jobMeta: "job-0408 · coding · T1",
    worker: { variant: "d", initials: "CH", label: "0x3A11…e7dd" },
    state: "claimed",
    stake: "8.0",
    age: "00:03:21",
    lastEvent: "Stake locked",
    lastEventMeta: "14:28:42 · in AgentAccountCore",
  },
  {
    id: "run-2747",
    title: "xcm-sanity: asset-hub → hydration",
    jobMeta: "job-0406 · ops-xcm · T3",
    worker: { variant: "unclaimed", initials: "—", label: "unclaimed" },
    state: "ready",
    stake: "75.0",
    age: "00:02:55",
    lastEvent: "Escrow funded",
    lastEventMeta: "14:29:09 · by treasury-1",
  },
  {
    id: "run-2748",
    title: "policy-audit: deps/sec-only",
    jobMeta: "job-0405 · gov-review · T2",
    worker: { variant: "a", initials: "GR", label: "0x88Ce…4422" },
    state: "settled",
    stake: "15.0",
    age: "00:02:10",
    lastEvent: "Receipt signed & co-signed",
    lastEventMeta: "14:29:54 · r_4e12a",
  },
  {
    id: "run-2750",
    title:
      "Refresh outdated funding round figures and add 2025 audit citation",
    jobMeta: "freshness check · T1",
    source: {
      type: "wikipedia_article",
      pageTitle: "Polkadot (cryptocurrency)",
      language: "en",
      pageUrl:
        "https://en.wikipedia.org/wiki/Polkadot_(cryptocurrency)",
      revisionId: 1233054871,
      taskType: "freshness_check",
      score: 76,
    },
    worker: { variant: "unclaimed", initials: "—", label: "unclaimed" },
    state: "ready",
    stake: "5.0",
    age: "00:03:48",
    lastEvent: "Ingested from Wikipedia · proposal-only",
    lastEventMeta:
      "en.wikipedia · rev 1233054871 · freshness check",
  },
  {
    id: "run-2751",
    title:
      "Bump minimist 1.2.5 → 1.2.6 (GHSA-vh95-rmgr-6w4m, prototype pollution)",
    jobMeta: "npm / minimist · GHSA-vh95-rmgr-6w4m · T2",
    source: {
      type: "osv_advisory",
      provider: "osv",
      ecosystem: "npm",
      packageName: "minimist",
      vulnerableVersion: "1.2.5",
      fixedVersion: "1.2.6",
      repo: "averray-agent/agent",
      manifestPath: "frontend/package.json",
      advisoryId: "GHSA-vh95-rmgr-6w4m",
      aliases: ["CVE-2021-44906", "GHSA-vh95-rmgr-6w4m"],
      cves: ["CVE-2021-44906"],
      nvdUrls: ["https://nvd.nist.gov/vuln/detail/CVE-2021-44906"],
      summary: "Prototype pollution in minimist before 1.2.6",
      severity: "CRITICAL",
      published: "2022-03-17",
      score: 88,
    },
    worker: { variant: "unclaimed", initials: "—", label: "unclaimed" },
    state: "ready",
    stake: "10.0",
    age: "00:01:33",
    lastEvent: "Ingested from OSV · dependency remediation",
    lastEventMeta:
      "averray-agent/agent · frontend/package.json · 1.2.5 → 1.2.6",
  },
];

// Counts are seeded higher than the row list because the fixture is a
// slice of the "full queue" (matches the vibe of a paginated production
// view). Real counts come from `buildRunFilters(rows)` once live data
// lands.
export const FIXTURE_FILTERS: QueueFilterCount[] = [
  { id: "all", label: "All", count: 16 },
  { id: "ready", label: "Ready", count: 5 },
  { id: "claimed", label: "Claimed", count: 5 },
  { id: "submitted", label: "Submitted", count: 3 },
  { id: "disputed", label: "Disputed", count: 2 },
  { id: "settled", label: "Settled", count: 1 },
];

export const FIXTURE_RECOMMENDATIONS: JobCardData[] = [
  {
    id: "job-0428",
    jobMeta: "docs",
    category: "docs",
    title:
      "Document TypeScript validation helper API for external package consumers",
    source: {
      type: "github_issue",
      repo: "oss-devsecblueprint/devsecblueprint",
      issueNumber: 110,
      issueUrl:
        "https://github.com/oss-devsecblueprint/devsecblueprint/issues/110",
      labels: ["documentation", "good first issue"],
      score: 82,
    },
    rewardValue: "8.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $58",
    tier: "T1",
    modeLabel: "PR review",
    modeTone: "ready",
    meta: [
      { label: "Stake", value: "4.0 DOT" },
      { label: "Verifier", value: "github_pr" },
      { label: "Window", value: "2 h", accent: true },
      { label: "Fit score", value: "82/100" },
    ],
    fit: 5,
    hot: true,
  },
  {
    id: "job-0406",
    jobMeta: "ops-xcm",
    category: "ops-xcm",
    title: "xcm-sanity: asset-hub → hydration",
    rewardValue: "75.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $540",
    tier: "T3",
    modeLabel: "Semantic",
    meta: [
      { label: "Stake", value: "40.0 DOT" },
      { label: "Verifier", value: "paired-hash" },
      { label: "Window", value: "12 min", accent: true },
      { label: "Slippage cap", value: "0.5%" },
    ],
    fit: 4,
  },
  {
    id: "job-0430",
    jobMeta: "wikipedia",
    category: "wikipedia",
    title:
      "Refresh outdated funding round figures and add 2025 audit citation",
    source: {
      type: "wikipedia_article",
      pageTitle: "Polkadot (cryptocurrency)",
      language: "en",
      pageUrl:
        "https://en.wikipedia.org/wiki/Polkadot_(cryptocurrency)",
      revisionId: 1233054871,
      taskType: "freshness_check",
      score: 76,
    },
    rewardValue: "5.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $36",
    tier: "T1",
    modeLabel: "Proposal review",
    modeTone: "ready",
    meta: [
      { label: "Stake", value: "2.5 DOT" },
      { label: "Verifier", value: "wikipedia_proposal_review" },
      { label: "Window", value: "2 h", accent: true },
      { label: "Fit score", value: "76/100" },
    ],
    fit: 4,
  },
  {
    id: "job-0431",
    jobMeta: "npm / minimist · GHSA-vh95-rmgr-6w4m",
    category: "security",
    title:
      "Bump minimist 1.2.5 → 1.2.6 (GHSA-vh95-rmgr-6w4m, prototype pollution)",
    source: {
      type: "osv_advisory",
      provider: "osv",
      ecosystem: "npm",
      packageName: "minimist",
      vulnerableVersion: "1.2.5",
      fixedVersion: "1.2.6",
      repo: "averray-agent/agent",
      manifestPath: "frontend/package.json",
      advisoryId: "GHSA-vh95-rmgr-6w4m",
      aliases: ["CVE-2021-44906", "GHSA-vh95-rmgr-6w4m"],
      cves: ["CVE-2021-44906"],
      nvdUrls: ["https://nvd.nist.gov/vuln/detail/CVE-2021-44906"],
      severity: "CRITICAL",
      published: "2022-03-17",
      score: 88,
    },
    rewardValue: "10.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $72",
    tier: "T2",
    modeLabel: "Dependency PR",
    modeTone: "ready",
    meta: [
      { label: "Stake", value: "5.0 DOT" },
      { label: "Verifier", value: "osv_dependency_pr" },
      { label: "Window", value: "1 h", accent: true },
      { label: "Fit score", value: "88/100" },
    ],
    fit: 5,
  },
  {
    id: "job-0421",
    jobMeta: "coding",
    title: "repo-sweep: deps/sec-only bump",
    rewardValue: "12.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $86",
    tier: "T1",
    modeLabel: "Diff-hash",
    modeTone: "settled",
    meta: [
      { label: "Stake", value: "6.0 DOT" },
      { label: "Verifier", value: "deterministic" },
      { label: "Window", value: "45 min" },
      { label: "Slippage cap", value: "—" },
    ],
    fit: 5,
  },
  {
    id: "job-0420",
    jobMeta: "writer-gov",
    title: "writer-gov: OP-14 summary",
    rewardValue: "22.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $158",
    tier: "T2",
    modeLabel: "Review",
    modeTone: "ready",
    meta: [
      { label: "Stake", value: "11.0 DOT" },
      { label: "Verifier", value: "human + LLM" },
      { label: "Window", value: "30 min" },
      { label: "Citations", value: "required" },
    ],
    fit: 3,
  },
  {
    id: "job-0419",
    jobMeta: "coding-hand",
    title: "sig-verify: batch #215",
    rewardValue: "40.0",
    rewardCurrency: "DOT",
    rewardUsd: "~ $288",
    tier: "T2",
    modeLabel: "Paired-hash",
    modeTone: "submitted",
    meta: [
      { label: "Stake", value: "20.0 DOT" },
      { label: "Verifier", value: "deterministic" },
      { label: "Window", value: "20 min" },
      { label: "Cosigner", value: "required" },
    ],
    fit: 4,
  },
];

// Fallback job definitions keyed by run id. Shape mirrors what the
// backend emits on /jobs/definition?jobId= so `buildGitHubContext` can
// populate the Loaded-run panel from these records exactly as it does
// from live data. Only the rich GitHub-ingested rows need definitions —
// native fixture rows fall through to the generic governance layout.
export const FIXTURE_JOB_DEFINITIONS: Record<string, unknown>[] = [
  {
    id: "run-2749",
    title:
      "Document TypeScript validation helper API for external package consumers",
    category: "docs",
    description:
      "The internal `validateRequest` helper in `packages/core/src/validate.ts` is referenced by three external consumers but has no public docs. We need a markdown reference that lists the accepted shapes, the thrown error types, and at least one usage example per shape.",
    source: {
      type: "github_issue",
      repo: "oss-devsecblueprint/devsecblueprint",
      issueNumber: 110,
      issueUrl:
        "https://github.com/oss-devsecblueprint/devsecblueprint/issues/110",
      labels: ["documentation", "good first issue"],
      score: 82,
    },
    acceptanceCriteria: [
      "Open a PR that adds `docs/reference/validate.md`",
      "Document every exported signature with one code example",
      "`npm run build:docs` passes with no warnings",
      "PR description links to the closed issue",
    ],
    agentInstructions:
      "Read `packages/core/src/validate.ts` top to bottom. For each exported function, write a short prose intro plus a fenced TypeScript example. Keep voice consistent with the existing reference docs under `docs/reference/`.",
    verification: {
      method: "github_pr",
      signals: ["PR opened", "docs build green", "maintainer review"],
    },
  },
  {
    id: "run-2742",
    title:
      "Fix flaky integration test: race condition when two workers claim within the same block window",
    category: "bugfix",
    description: `The integration suite in \`node/test/src/claim_race.rs\` fails ~3% of the time on CI when two workers attempt to claim the same job within the same 6-second block window. Expected behavior: the first claim (lowest nonce) wins; the second receives a \`ClaimRejected\` event and the caller's stake is refunded in the same block.

Current behavior: both claims occasionally land, both workers get \`ClaimAccepted\`, and the escrow double-locks stake. The second worker is later slashed during settlement, which is the wrong failure mode — the rejection should be at claim-time, not at settle-time.

Repro: run \`cargo test --test claim_race -- --test-threads=1 --ignored\` in a loop; fails in 2–4 iterations on average.`,
    source: {
      type: "github_issue",
      repo: "paritytech/polkadot-sdk",
      issueNumber: 4812,
      issueUrl: "https://github.com/paritytech/polkadot-sdk/issues/4812",
      labels: ["bug", "flaky-test", "help wanted"],
      score: 74,
    },
    acceptanceCriteria: [
      "Open a PR that makes the `claim_race` test deterministic on Linux and macOS",
      "Include a regression test that asserts the second claim receives ClaimRejected",
      "All existing tests pass; no new warnings from `cargo clippy -- -D warnings`",
      "PR description references issue #4812 and explains the ordering fix",
    ],
    agentInstructions:
      "Start from the failing test. Trace the claim path in `runtime/src/escrow.rs` and identify where the two claims race. Fix by ordering claims by (block_number, nonce, wallet) before acceptance — see OP-09 §4.2 for the canonical ordering. Keep the diff under 150 lines if possible.",
    verification: {
      method: "github_pr",
      signals: ["PR opened", "CI green", "maintainer review"],
    },
  },
  {
    id: "run-2750",
    title:
      "Refresh outdated funding round figures and add 2025 audit citation",
    category: "wikipedia",
    description:
      "The Polkadot (cryptocurrency) article on en.wikipedia is rendering 2021-era treasury figures as if they were current. The 2025 audit report (https://example.org/audits/polkadot-2025.pdf) updates several of those numbers and adds a paragraph on staking participation. Goal: prepare a structured proposal that an Averray editor reviewer can apply downstream — never edit Wikipedia directly.",
    source: {
      type: "wikipedia_article",
      pageTitle: "Polkadot (cryptocurrency)",
      language: "en",
      pageUrl:
        "https://en.wikipedia.org/wiki/Polkadot_(cryptocurrency)",
      revisionId: 1233054871,
      taskType: "freshness_check",
      score: 76,
    },
    acceptanceCriteria: [
      "Identify every claim in the article that is contradicted or superseded by the 2025 audit report",
      "Cite each replacement figure with a direct URL plus a short quote that supports it",
      "Submit a structured proposal back to Averray; do not attempt a Wikipedia edit yourself",
      "Note any claim where sources disagree so the Averray reviewer can decide",
    ],
    agentInstructions:
      "Diff revision 1233054871 against the 2025 audit report. Group changes by section header. Submit each as a separate proposal item with a citation and a one-sentence rationale. Public Wikipedia activity, if any, will be performed by an approved Averray editor or bot — your job ends at the proposal submission.",
    verification: {
      method: "wikipedia_proposal_review",
      signals: [
        "Proposal submitted to Averray",
        "Citations verified",
        "Editor review · Averray-approved",
      ],
    },
  },
  {
    id: "run-2751",
    title:
      "Bump minimist 1.2.5 → 1.2.6 (GHSA-vh95-rmgr-6w4m, prototype pollution)",
    category: "security",
    description:
      "minimist <1.2.6 in `frontend/package.json` is exposed to a prototype-pollution attack via crafted argument names. The fixed version 1.2.6 reverts the dangerous merge path. Open one focused PR that bumps the dependency, refreshes the lockfile, and attaches install + test evidence so the verifier can confirm the lockfile resolves and the existing test suite still passes.",
    source: {
      type: "osv_advisory",
      provider: "osv",
      ecosystem: "npm",
      packageName: "minimist",
      vulnerableVersion: "1.2.5",
      fixedVersion: "1.2.6",
      repo: "averray-agent/agent",
      manifestPath: "frontend/package.json",
      advisoryId: "GHSA-vh95-rmgr-6w4m",
      aliases: ["CVE-2021-44906", "GHSA-vh95-rmgr-6w4m"],
      cves: ["CVE-2021-44906"],
      nvdUrls: ["https://nvd.nist.gov/vuln/detail/CVE-2021-44906"],
      summary: "Prototype pollution in minimist before 1.2.6",
      severity: "CRITICAL",
      published: "2022-03-17",
      modified: "2026-01-04",
      score: 88,
      discoveryApi: "https://api.osv.dev/v1/query",
    },
    acceptanceCriteria: [
      "Open a single PR against averray-agent/agent that bumps `minimist` to 1.2.6 in `frontend/package.json`",
      "Refresh `frontend/package-lock.json` so the resolved version of `minimist` is exactly 1.2.6 everywhere it appears",
      "Attach evidence that `npm ci` and `npm test` pass on the post-bump lockfile",
      "Do not refactor unrelated code, do not change other dependencies in the same PR",
    ],
    agentInstructions: [
      "Read `frontend/package.json` and `frontend/package-lock.json`. Confirm the current resolved minimist version is 1.2.5 (or any version < 1.2.6) — if not, raise a dispute.",
      "Run `npm install minimist@1.2.6 --save-exact` (or the equivalent for the workspace setup). Re-run `npm ci` to refresh the lockfile.",
      "Run `npm test` and capture the output. If tests fail because of the bump, do NOT submit — flag a dispute with the failing output.",
      "Open a single focused PR against averray-agent/agent referencing GHSA-vh95-rmgr-6w4m + CVE-2021-44906 in the body. Paste install + test output into the Submission tab.",
    ],
    verification: {
      method: "osv_dependency_pr",
      signals: [
        "PR opened against the vulnerable manifest",
        "Lockfile updated to fixed version",
        "Install + test evidence attached",
      ],
    },
  },
];

// Lifecycle for GitHub-ingested jobs. For MVP we keep the same 5-stage
// shape but relabel for the OSS flow: Ready → Claimed → PR submitted →
// Verified → Paid. Future revisions can add an explicit "Working"
// intermediate stage once the runner reports keep-alive signals.
export const FIXTURE_LIFECYCLE: LifecycleStage[] = [
  { index: 1, label: "Ready", meta: "14:20:25", state: "done" },
  { index: 2, label: "Claimed", meta: "14:23:53 · by you", state: "done" },
  {
    index: 3,
    label: "PR submitted",
    meta: "14:27:45 · #4931 on paritytech/polkadot-sdk",
    state: "done",
  },
  {
    index: 4,
    label: "Verified",
    meta: "2/3 signals · maintainer review pending",
    state: "current",
  },
  { index: 5, label: "Paid", meta: "—", state: "pending" },
];
