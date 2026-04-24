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
  buildRunRows,
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

  return (
    <div className="flex flex-col gap-3.5">
      <LoadedRunPanel
        kicker="Loaded run"
        title={loadedRow.title}
        meta={loadedRow.jobMeta}
        state={loadedRow.state}
        github={loadedGitHub}
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
        // When `github` is set the panel swaps Evidence for the four-tab
        // Issue/Acceptance/Instructions/Submission block. `evidence` is
        // then unused at runtime but stays type-required.
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

      {showLifecycle ? (
        <LifecycleRail
          runId={loadedRow.id}
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
          stages={FIXTURE_LIFECYCLE}
          next={{
            label: "Next",
            value: "Maintainer review → Pay",
            sub: "auto-pays on PR merge + CI green",
          }}
        />
      ) : null}

      <ReceiptPreviewDrawer
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        draft={buildReceiptDraft(loadedRow, loadedGitHub)}
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
 * extra fetch. For native (non-GitHub) runs the signer list flips from
 * maintainer to cosigner and the source block is skipped.
 */
function buildReceiptDraft(
  row: RunRow,
  github: ReturnType<typeof buildGitHubContext>
): ReceiptPreviewDraft {
  const workerSignerLabel = row.worker.isSelf
    ? `Worker · ${row.worker.label} (you)`
    : `Worker · ${row.worker.label}`;

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
    verdict: {
      status: github
        ? "Awaiting maintainer review"
        : "Verified (pending cosign)",
      score: github ? "2 / 3" : "4 / 5",
      confidence: github ? "0.86 confidence" : "0.92 confidence",
    },
    evidenceHash: "sha256 0x9c…41",
    ...(github ? { github } : {}),
    prUrl: github ? `https://github.com/${github.repo}/pull/4931` : undefined,
    signers: [
      { label: workerSignerLabel, status: "pending" },
      {
        label: github
          ? "Maintainer · awaiting review"
          : "Cosigner · 0x9A13…0cb2",
        status: "pending",
      },
      { label: "Verifier · verifier-2", status: "signed" },
    ],
  };
}
