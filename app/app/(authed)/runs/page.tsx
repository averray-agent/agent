"use client";

import { useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { RunsTopbar } from "@/components/runs/RunsTopbar";
import {
  QueueBar,
  type QueueFilter,
  type QueueFilterCount,
} from "@/components/runs/QueueBar";
import {
  RunQueueTable,
  type RunRow,
} from "@/components/runs/RunQueueTable";
import { RecommendationRail } from "@/components/runs/RecommendationRail";
import type { JobCardData } from "@/components/runs/JobCard";
import { LoadedRunPanel } from "@/components/runs/LoadedRunPanel";
import {
  LifecycleRail,
  type LifecycleStage,
} from "@/components/runs/LifecycleRail";
import { useJobDefinition, useJobs, useRecommendations } from "@/lib/api/hooks";
import { swrFetcher } from "@/lib/api/client";
import {
  buildGitHubContext,
  buildRecommendationCards,
  buildRunFilters,
  buildRunRows,
  extractRunJobs,
  sumReadyStake,
} from "@/lib/api/run-adapters";

// TODO(data): replace each block's seed data with the matching SWR hook
//   - Run queue: useSessions() filtered by state
//   - Recommendation rail: useRecommendations()
//   - Loaded run: useSession(sessionId) — selected from URL or state
//   - Lifecycle: useSessionStateMachine() + the loaded session's history
// Until those hook response shapes are stable, the page renders the same
// fixture data Claude Design used so the layout reads correctly.

const ROWS: RunRow[] = [
  {
    id: "run-2749",
    title:
      "Document TypeScript validation helper API for external package consumers",
    jobMeta: "job-0428 · docs · T1",
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
    jobMeta: "job-0418 · bugfix · T2",
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
];

const FILTERS: QueueFilterCount[] = [
  { id: "all", label: "All", count: 15 },
  { id: "ready", label: "Ready", count: 4 },
  { id: "claimed", label: "Claimed", count: 5 },
  { id: "submitted", label: "Submitted", count: 3 },
  { id: "disputed", label: "Disputed", count: 2 },
  { id: "settled", label: "Settled", count: 1 },
];

const RECOMMENDED: JobCardData[] = [
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

// Fallback job definitions used when the live API is unavailable. Shape
// mirrors what the backend emits on /jobs/definition?jobId=, so the
// adapter (buildGitHubContext) can populate the Loaded-run panel from
// these records exactly as it does from live data. Only the rich
// GitHub-ingested rows need definitions — native fixture rows fall
// through to the generic governance layout.
const FIXTURE_JOB_DEFINITIONS: Record<string, unknown>[] = [
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
];

// Lifecycle for GitHub-ingested jobs. For MVP we keep the same 5-stage
// shape but relabel for the OSS flow: Ready → Claimed → PR submitted →
// Verified → Paid. Future revisions can add an explicit "Working"
// intermediate stage once the runner reports keep-alive signals.
const LIFECYCLE: LifecycleStage[] = [
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

export default function RunsPage() {
  const [activeFilter, setActiveFilter] = useState<QueueFilter>("all");
  const [selectedId, setSelectedId] = useState<string>("run-2742");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const jobs = useJobs();
  const recommendations = useRecommendations();

  const liveRows = useMemo(() => buildRunRows(jobs.data), [jobs.data]);
  const rows = liveRows.length ? liveRows : ROWS;
  const filters = useMemo(() => buildRunFilters(rows), [rows]);
  const recommendationCards = useMemo(() => {
    const liveCards = buildRecommendationCards(recommendations.data, jobs.data);
    return liveCards.length ? liveCards : RECOMMENDED;
  }, [jobs.data, recommendations.data]);
  const rawJobs = useMemo(() => extractRunJobs(jobs.data), [jobs.data]);
  const loadedRow = rows.find((row) => row.id === selectedId) ?? rows[0] ?? ROWS[0];

  useEffect(() => {
    if (rows.length && !rows.some((row) => row.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const visibleRows = useMemo(() => {
    if (activeFilter === "all") return rows;
    return rows.filter((r) => r.state === activeFilter);
  }, [activeFilter, rows]);

  const assignedToMe = rows.filter((row) => row.worker.isSelf).length;
  const jobDefinition = useJobDefinition(loadedRow.id);
  const selectedJob =
    asRecord(jobDefinition.data) ??
    rawJobs.find((job) => job.id === loadedRow.id) ??
    FIXTURE_JOB_DEFINITIONS.find((def) => def.id === loadedRow.id);
  // Only set when the loaded run was ingested from GitHub. The panel
  // switches to a GitHub-native layout when this is defined; otherwise
  // it keeps the generic governance evidence/verifier layout.
  const loadedGitHub = buildGitHubContext(loadedRow, selectedJob);
  const liveStatus = jobs.error
    ? "fixture fallback"
      : jobs.isLoading
        ? "loading live jobs"
        : "live API";
  const handleSubmit = async (evidence: string) => {
    setSubmitError(null);
    if (!loadedRow.sessionId) {
      setSubmitError("Claim this run before submitting evidence.");
      return;
    }
    setSubmitting(true);
    try {
      await swrFetcher([
        "/jobs/submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: loadedRow.sessionId,
            submission: {
              evidence,
              jobId: loadedRow.id,
              submittedAt: new Date().toISOString(),
            },
          }),
        },
      ]);
      mutate("/jobs");
      mutate("/sessions");
    } catch {
      setSubmitError("Could not submit this run. Check session ownership and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-3.5">
      <RunsTopbar />
      <QueueBar filters={filters.length ? filters : FILTERS} active={activeFilter} onChange={setActiveFilter} />

      <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <RunQueueTable
          rows={visibleRows}
          selectedId={selectedId}
          onSelect={setSelectedId}
          shownCount={visibleRows.length}
          totalCount={rows.length}
          unclaimedStake={sumReadyStake(rows)}
          assignedToMe={assignedToMe}
          liveStatus={liveStatus}
        />
        <RecommendationRail
          workerTier="live"
          workerScore={recommendations.error ? 0 : recommendationCards.length}
          jobs={recommendationCards}
          totalMatches={recommendationCards.length}
        />
      </div>

      <LoadedRunPanel
        kicker="Loaded run"
        title={loadedRow.title}
        meta={loadedRow.jobMeta}
        github={loadedGitHub}
        stake={{
          amount: loadedRow.stake,
          aux: selectedJob
            ? `${selectedJob.rewardAsset ?? "DOT"} reward · verifier ${selectedJob.verifierMode ?? "unknown"}`
            : "fixture data · waiting for live selection",
          breakdown: {
            worker: `${loadedRow.stake} DOT`,
            verifier: "0 DOT",
            treasury: "0 DOT",
          },
        }}
        // When `github` is set the panel swaps Evidence for the four-tab
        // Issue/Acceptance/Instructions/Submission block, so `evidence` is
        // unused at runtime. The prop is still type-required — we stub it
        // with neutral content that will never render for this job.
        evidence={{
          tabs: [{ id: "issue", label: "Issue" }],
          activeTab: "issue",
          metaRight: "",
          metaFoot: "",
          sample: "",
        }}
        submission={{
          note: (
            <>
              Submits <b className="text-[var(--avy-ink)]">PR URL + evidence</b>{" "}
              to the verifier. Window{" "}
              <b className="text-[var(--avy-ink)]">00:08:14 / 02:00:00</b>.
            </>
          ),
          cta: "Submit for verification",
          onSubmit: handleSubmit,
          submitting,
          error: submitError,
        }}
        verifier={{
          runner: "verifier-2 · github_pr · handler-v0.14",
          elapsed: "stream · 3.4s",
          modeNote: "github_pr · maintainer-reviewed",
          lines: [
            {
              time: "14:28:01",
              level: "info",
              label: "source",
              message: (
                <>
                  loaded issue{" "}
                  <span className="text-[#f4c989]">
                    paritytech/polkadot-sdk#4812
                  </span>{" "}
                  · score 74/100
                </>
              ),
            },
            {
              time: "14:28:01",
              level: "ok",
              label: "pass",
              message: (
                <>
                  PR URL present ·{" "}
                  <span className="text-[#f4c989]">pull/4931</span>
                </>
              ),
            },
            {
              time: "14:28:02",
              level: "ok",
              label: "pass",
              message: <>PR body references issue #4812</>,
            },
            {
              time: "14:28:02",
              level: "ok",
              label: "pass",
              message: (
                <>
                  CI checks green · <span className="text-[#9bd7b5]">7/7</span>{" "}
                  on ubuntu-latest · macos-13
                </>
              ),
            },
            {
              time: "14:28:03",
              level: "warn",
              label: "note",
              message: (
                <>
                  maintainer review{" "}
                  <span className="text-[#f4c989]">pending</span> · requested
                  from @bkchr
                </>
              ),
            },
            {
              time: "14:28:03",
              level: "ok",
              label: "verdict",
              message: (
                <>
                  2/3 signals pass · awaiting maintainer · receipt draft{" "}
                  <span className="text-[#f4c989]">r_4e133</span>
                </>
              ),
            },
          ],
          verdict: {
            status: "Awaiting maintainer review",
            score: "2 / 3",
            scoreLabel: "0.86 confidence",
          },
        }}
        settle={{
          title: "Awaiting verification",
          detail: (
            <>
              On verification, pay{" "}
              <b className="text-[var(--avy-ink)]">25.00 DOT</b> · unlock{" "}
              <b className="text-[var(--avy-ink)]">25.00 DOT</b> stake · sign
              receipt <b className="text-[var(--avy-ink)]">r_4e133</b>
            </>
          ),
          cta: "Mark verified & pay",
          ctaDisabled: true,
          note: "pays worker & verifier once the maintainer approves the PR",
        }}
      />

      <LifecycleRail
        runId="run-2742"
        contextNote={
          <>
            Window closes in{" "}
            <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
            {" · "}verification{" "}
            <b className="font-semibold text-[var(--avy-ink)]">github_pr</b>
            {" · "}PR{" "}
            <b className="font-semibold text-[var(--avy-ink)]">#4931</b> opened
          </>
        }
        stages={LIFECYCLE}
        next={{
          label: "Next",
          value: "Maintainer review → Pay",
          sub: "auto-pays on PR merge + CI green",
        }}
      />
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
