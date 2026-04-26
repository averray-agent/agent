"use client";

import { useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { LoadedRunPanel } from "./LoadedRunPanel";
import { LifecycleRail } from "./LifecycleRail";
import {
  ReceiptPreviewDrawer,
  type ReceiptPreviewDraft,
} from "./ReceiptPreviewDrawer";
import {
  FIXTURE_JOB_DEFINITIONS,
  FIXTURE_LIFECYCLE,
  FIXTURE_RUN_ROWS,
} from "./fixtures";
import type { RunRow } from "./RunQueueTable";
import { swrFetcher } from "@/lib/api/client";
import { useJobDefinition, useJobs } from "@/lib/api/hooks";
import {
  buildGitHubContext,
  buildOsvContext,
  buildRunRows,
  buildWikipediaContext,
  extractRunJobs,
} from "@/lib/api/run-adapters";

/**
 * Self-contained detail view for a single run.
 *
 * Looks up the row (live or fixture), resolves the job definition,
 * builds the GitHub job context, wires the submit handler, owns the
 * receipt-preview drawer state, and renders LoadedRunPanel + LifecycleRail.
 *
 * Both consumers use it:
 *   - `/runs/` — the split-pane queue page, in the sticky right column
 *     (selectedRunId tracks the clicked row)
 *   - `/runs/detail/?id=<id>` — the standalone fullscreen view
 *
 * Keeps the fixture-driven verifier / settlement / lifecycle copy inline
 * because the backend doesn't yet stream real verifier output; swap
 * these for live data once those endpoints land.
 */
export interface LoadedRunViewProps {
  runId: string;
  /**
   * URL that opens this run in a dedicated fullscreen view. Omit on
   * the standalone page itself (so the "Full view" button doesn't link
   * to the page you're already on).
   */
  standaloneUrl?: string;
  /** Hide the lifecycle rail when the host already renders one. */
  showLifecycle?: boolean;
}

export function LoadedRunView({
  runId,
  standaloneUrl,
  showLifecycle = true,
}: LoadedRunViewProps) {
  const jobs = useJobs();
  const liveRows = useMemo(() => buildRunRows(jobs.data), [jobs.data]);
  const rows = liveRows.length ? liveRows : FIXTURE_RUN_ROWS;
  const rawJobs = useMemo(() => extractRunJobs(jobs.data), [jobs.data]);
  const loadedRow =
    rows.find((row) => row.id === runId) ?? rows[0] ?? FIXTURE_RUN_ROWS[0];

  const jobDefinition = useJobDefinition(loadedRow.id);
  const selectedJob =
    asRecord(jobDefinition.data) ??
    rawJobs.find((job) => job.id === loadedRow.id) ??
    FIXTURE_JOB_DEFINITIONS.find((def) => def.id === loadedRow.id);
  const loadedGitHub = buildGitHubContext(loadedRow, selectedJob);
  const loadedWikipedia = buildWikipediaContext(loadedRow, selectedJob);
  const loadedOsv = buildOsvContext(loadedRow, selectedJob);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

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
      setSubmitError(
        "Could not submit this run. Check session ownership and try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Source-aware kicker so the very top of the panel reads as
  // "what kind of work is this" before the worker scans the title.
  // Avoids the marketing-flat "Loaded run" label on every run regardless
  // of provenance, which previously left an operator to read the source
  // strip lower down to figure out whether the page applied to a GitHub
  // PR review or a Wikipedia proposal review.
  const kicker = loadedWikipedia
    ? "Loaded run · Wikipedia article"
    : loadedGitHub
      ? "Loaded run · GitHub issue"
      : loadedOsv
        ? "Loaded run · OSV advisory"
        : "Loaded run";

  return (
    <div className="flex flex-col gap-3.5">
      <LoadedRunPanel
        kicker={kicker}
        title={loadedRow.title}
        meta={loadedRow.jobMeta}
        state={loadedRow.state}
        github={loadedGitHub}
        wikipedia={loadedWikipedia}
        osv={loadedOsv}
        onReceiptPreview={() => setReceiptOpen(true)}
        standaloneUrl={standaloneUrl}
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
        // When `github` or `wikipedia` is set the panel swaps Evidence
        // for the source-specific four-tab block. `evidence` is then
        // unused at runtime but stays type-required, so we hand it a
        // single neutral "Brief" tab — the previous "Issue" label
        // leaked GitHub-domain language onto native runs.
        evidence={{
          tabs: [{ id: "brief", label: "Brief" }],
          activeTab: "brief",
          metaRight: "",
          metaFoot: "",
          sample: "",
        }}
        submission={{
          note: loadedWikipedia ? (
            <>
              Submits{" "}
              <b className="text-[var(--avy-ink)]">proposed change summary + citations</b>{" "}
              to Averray. No direct Wikipedia edits. Window{" "}
              <b className="text-[var(--avy-ink)]">00:08:14 / 02:00:00</b>.
            </>
          ) : loadedOsv ? (
            <>
              Submits{" "}
              <b className="text-[var(--avy-ink)]">PR URL + lockfile + install/test evidence</b>{" "}
              to the verifier. Window{" "}
              <b className="text-[var(--avy-ink)]">00:08:14 / 02:00:00</b>.
            </>
          ) : (
            <>
              Submits <b className="text-[var(--avy-ink)]">PR URL + evidence</b>{" "}
              to the verifier. Window{" "}
              <b className="text-[var(--avy-ink)]">00:08:14 / 02:00:00</b>.
            </>
          ),
          cta: loadedWikipedia
            ? "Submit proposal for review"
            : loadedOsv
              ? "Submit remediation PR"
              : "Submit for verification",
          onSubmit: handleSubmit,
          submitting,
          error: submitError,
        }}
        verifier={
          loadedOsv
            ? {
                runner: "verifier-2 · osv_dependency_pr · handler-v0.14",
                elapsed: "stream · 3.4s",
                modeNote: "osv_dependency_pr · maintainer-reviewed",
                lines: [
                  {
                    time: "14:28:01",
                    level: "info",
                    label: "advisory",
                    message: (
                      <>
                        loaded{" "}
                        <span className="text-[#f4c989]">
                          {loadedOsv.advisoryId}
                        </span>{" "}
                        · {loadedOsv.ecosystem}/{loadedOsv.packageName}{" "}
                        {loadedOsv.vulnerableVersion} → {loadedOsv.fixedVersion}
                      </>
                    ),
                  },
                  {
                    time: "14:28:01",
                    level: "ok",
                    label: "pass",
                    message: (
                      <>
                        manifest scope ok · only{" "}
                        <span className="text-[#f4c989]">
                          {loadedOsv.manifestPath}
                        </span>{" "}
                        + lockfile touched
                      </>
                    ),
                  },
                  {
                    time: "14:28:02",
                    level: "ok",
                    label: "pass",
                    message: <>lockfile resolves to {loadedOsv.fixedVersion}</>,
                  },
                  {
                    time: "14:28:02",
                    level: "ok",
                    label: "pass",
                    message: (
                      <>
                        install + test green ·{" "}
                        <span className="text-[#9bd7b5]">npm ci · npm test</span>
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
                        <span className="text-[#f4c989]">pending</span>
                      </>
                    ),
                  },
                  {
                    time: "14:28:03",
                    level: "ok",
                    label: "verdict",
                    message: (
                      <>
                        3/4 signals pass · awaiting maintainer · receipt draft{" "}
                        <span className="text-[#f4c989]">r_4e133</span>
                      </>
                    ),
                  },
                ],
                verdict: {
                  status: "Awaiting maintainer review",
                  score: "3 / 4",
                  scoreLabel: "0.91 confidence",
                },
              }
            : loadedWikipedia
            ? {
                runner: "verifier-2 · wikipedia_proposal_review · handler-v0.14",
                elapsed: "stream · 3.4s",
                modeNote:
                  "wikipedia_proposal_review · Averray-approved editor only",
                lines: [
                  {
                    time: "14:28:01",
                    level: "info",
                    label: "source",
                    message: (
                      <>
                        loaded article{" "}
                        <span className="text-[#f4c989]">
                          {loadedWikipedia.language}.wikipedia /{" "}
                          {loadedWikipedia.pageTitle}
                        </span>{" "}
                        · rev {loadedWikipedia.revisionId}
                      </>
                    ),
                  },
                  {
                    time: "14:28:01",
                    level: "ok",
                    label: "pass",
                    message: <>proposal payload present · structured ok</>,
                  },
                  {
                    time: "14:28:02",
                    level: "ok",
                    label: "pass",
                    message: <>citations resolve · 4/4 sources reachable</>,
                  },
                  {
                    time: "14:28:02",
                    level: "info",
                    label: "policy",
                    message: (
                      <>
                        proposal-only path enforced ·{" "}
                        <span className="text-[#f4c989]">no direct edit</span>
                      </>
                    ),
                  },
                  {
                    time: "14:28:03",
                    level: "warn",
                    label: "note",
                    message: (
                      <>
                        Averray editor reviewer{" "}
                        <span className="text-[#f4c989]">pending</span>
                      </>
                    ),
                  },
                  {
                    time: "14:28:03",
                    level: "ok",
                    label: "verdict",
                    message: (
                      <>
                        1/2 signals pass · awaiting reviewer · receipt draft{" "}
                        <span className="text-[#f4c989]">r_4e133</span>
                      </>
                    ),
                  },
                ],
                verdict: {
                  status: "Awaiting Averray editor review",
                  score: "1 / 2",
                  scoreLabel: "0.74 confidence",
                },
              }
            : {
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
                        CI checks green ·{" "}
                        <span className="text-[#9bd7b5]">7/7</span> on
                        ubuntu-latest · macos-13
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
                        <span className="text-[#f4c989]">pending</span> ·
                        requested from @bkchr
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
              }
        }
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
          note: loadedWikipedia
            ? "pays worker & verifier once an Averray editor approves the proposal"
            : loadedOsv
              ? "pays worker & verifier once the maintainer merges the remediation PR"
              : "pays worker & verifier once the maintainer approves the PR",
        }}
      />

      {showLifecycle ? (
        <LifecycleRail
          runId={loadedRow.id}
          contextNote={
            loadedWikipedia ? (
              <>
                Window closes in{" "}
                <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
                {" · "}verification{" "}
                <b className="font-semibold text-[var(--avy-ink)]">
                  {loadedWikipedia.verification.method}
                </b>
                {" · "}proposal{" "}
                <b className="font-semibold text-[var(--avy-ink)]">submitted</b>{" "}
                · pending Averray review
              </>
            ) : loadedOsv ? (
              <>
                Window closes in{" "}
                <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
                {" · "}verification{" "}
                <b className="font-semibold text-[var(--avy-ink)]">
                  {loadedOsv.verification.method}
                </b>
                {" · "}advisory{" "}
                <b className="font-semibold text-[var(--avy-ink)]">
                  {loadedOsv.advisoryId}
                </b>{" "}
                · PR pending merge
              </>
            ) : (
              <>
                Window closes in{" "}
                <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
                {" · "}verification{" "}
                <b className="font-semibold text-[var(--avy-ink)]">github_pr</b>
                {" · "}PR{" "}
                <b className="font-semibold text-[var(--avy-ink)]">#4931</b> opened
              </>
            )
          }
          stages={FIXTURE_LIFECYCLE}
          next={{
            label: "Next",
            value: loadedWikipedia
              ? "Averray review → Pay"
              : loadedOsv
                ? "Maintainer merge → Pay"
                : "Maintainer review → Pay",
            sub: loadedWikipedia
              ? "auto-pays on Averray-approved review"
              : loadedOsv
                ? "auto-pays on PR merge + CI green + lockfile resolves"
                : "auto-pays on PR merge + CI green",
          }}
        />
      ) : null}

      <ReceiptPreviewDrawer
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        draft={buildReceiptDraft(
          loadedRow,
          loadedGitHub,
          loadedWikipedia,
          loadedOsv
        )}
      />
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Assemble the unsigned receipt that would be signed on "Mark verified
 * & pay". Derived entirely from what the panel already shows — no
 * extra fetch. Source-aware: GitHub flows reference a PR + maintainer,
 * Wikipedia flows reference the article + an Averray editor reviewer
 * (since the platform never edits Wikipedia directly), OSV flows
 * reference the advisory + the consumer's maintainer (the focused PR
 * lands in the consumer repo, not the upstream package), native flows
 * fall back to a generic cosign signer list.
 */
function buildReceiptDraft(
  row: RunRow,
  github: ReturnType<typeof buildGitHubContext>,
  wikipedia: ReturnType<typeof buildWikipediaContext>,
  osv: ReturnType<typeof buildOsvContext>
): ReceiptPreviewDraft {
  const workerSignerLabel = row.worker.isSelf
    ? `Worker · ${row.worker.label} (you)`
    : `Worker · ${row.worker.label}`;

  const verdict = github
    ? {
        status: "Awaiting maintainer review",
        score: "2 / 3",
        confidence: "0.86 confidence",
      }
    : wikipedia
      ? {
          status: "Awaiting Averray editor review",
          score: "1 / 2",
          confidence: "0.74 confidence",
        }
      : osv
        ? {
            status: "Awaiting maintainer merge",
            score: "3 / 4",
            confidence: "0.91 confidence",
          }
        : {
            status: "Verified (pending cosign)",
            score: "4 / 5",
            confidence: "0.92 confidence",
          };

  const reviewerSigner = github
    ? "Maintainer · awaiting review"
    : wikipedia
      ? "Averray editor reviewer · awaiting review"
      : osv
        ? "Maintainer · awaiting merge"
        : "Cosigner · 0x9A13…0cb2";

  return {
    receiptRef: "r_4e133",
    runId: row.id,
    jobMeta: row.jobMeta,
    state: row.state,
    stake: {
      amount: row.stake,
      currency: "DOT",
      breakdown: [
        { label: "Worker payout", value: `${row.stake} DOT` },
        { label: "Verifier fee", value: "0 DOT" },
        { label: "Treasury reserve", value: "0 DOT" },
      ],
    },
    verdict,
    evidenceHash: "sha256 0x9c…41",
    ...(github ? { github } : {}),
    ...(wikipedia ? { wikipedia } : {}),
    ...(osv ? { osv } : {}),
    prUrl: github
      ? `https://github.com/${github.repo}/pull/4931`
      : osv
        ? `https://github.com/${osv.repo}/pull/8421`
        : undefined,
    signers: [
      { label: workerSignerLabel, status: "pending" },
      { label: reviewerSigner, status: "pending" },
      { label: "Verifier · verifier-2", status: "signed" },
    ],
  };
}
