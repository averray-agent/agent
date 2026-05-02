"use client";

import { useMemo, useState } from "react";
import { mutate } from "swr";
import { LoadedRunPanel } from "./LoadedRunPanel";
import { LifecycleRail } from "./LifecycleRail";
import { LifecycleActionBar } from "./LifecycleActionBar";
import { RunSemanticBlock } from "./RunSemanticBlock";
import {
  ReceiptPreviewDrawer,
  type ReceiptPreviewDraft,
} from "./ReceiptPreviewDrawer";
import {
  buildLifecycleStages,
  describeClaimer,
  formatDeadline,
} from "./buildLifecycleStages";
import type { RunRow } from "./RunQueueTable";
import { ApiError, swrFetcher } from "@/lib/api/client";
import { useAdminJobs, useJobDefinition, useJobs } from "@/lib/api/hooks";
import {
  buildGitHubContext,
  buildOpenDataContext,
  buildOsvContext,
  buildRunRows,
  buildWikipediaContext,
  extractRunJobs,
} from "@/lib/api/run-adapters";
import { extractAdminJobs } from "@/lib/api/job-lifecycle";

/**
 * Self-contained detail view for a single run.
 *
 * Looks up the live row, resolves the job definition,
 * builds the GitHub job context, wires the submit handler, owns the
 * receipt-preview drawer state, and renders LoadedRunPanel + LifecycleRail.
 *
 * Both consumers use it:
 *   - `/runs/` — the split-pane queue page, in the sticky right column
 *     (selectedRunId tracks the clicked row)
 *   - `/runs/detail/?id=<id>` — the standalone fullscreen view
 *
 * Keeps the static verifier / settlement / lifecycle copy inline
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
  const adminJobs = useAdminJobs();
  // Prefer the admin job feed (carries lifecycle metadata + paused/
  // archived/stale rows). Fall back to the public feed until the admin
  // payload arrives so we don't render an empty panel on first paint.
  const adminPayload = adminJobs.data ? extractAdminJobs(adminJobs.data) : [];
  const sourceForRows = adminPayload.length ? adminPayload : jobs.data;
  const liveRows = useMemo(() => buildRunRows(sourceForRows), [sourceForRows]);
  const rows = liveRows;
  const rawJobs = useMemo(() => extractRunJobs(sourceForRows), [sourceForRows]);
  const loadedRow = rows.find((row) => row.id === runId) ?? rows[0];

  const jobDefinition = useJobDefinition(loadedRow?.id ?? null);
  const selectedJob = loadedRow
    ? asRecord(jobDefinition.data) ?? rawJobs.find((job) => job.id === loadedRow.id)
    : undefined;
  const loadedGitHub = loadedRow ? buildGitHubContext(loadedRow, selectedJob) : undefined;
  const loadedWikipedia = loadedRow ? buildWikipediaContext(loadedRow, selectedJob) : undefined;
  const loadedOsv = loadedRow ? buildOsvContext(loadedRow, selectedJob) : undefined;
  const loadedOpenData = loadedRow ? buildOpenDataContext(loadedRow, selectedJob) : undefined;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  if (!loadedRow) {
    return (
      <div className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-5 font-[family-name:var(--font-body)] text-sm text-[var(--avy-muted)] shadow-[var(--shadow-card)]">
        No live run details available.
      </div>
    );
  }

  // PR #123 added a per-job `submissionContract` block on /jobs that
  // tells callers exactly what shape `payload.submission` should take
  // (including a `submitPayloadExample.submission` skeleton).
  // Surfacing it on the operator panel turns the previously-stubbed
  // textarea into a useful template editor: the operator sees the
  // schema-shaped example pre-filled, edits the placeholder values,
  // and submits something the verifier can actually validate.
  const submissionContract = asRecord(selectedJob?.submissionContract);
  const submissionExample = asRecord(
    asRecord(submissionContract?.submitPayloadExample)?.submission
  );
  const submissionSample = submissionExample
    ? JSON.stringify(submissionExample, null, 2)
    : "";
  const outputSchemaUrl =
    typeof submissionContract?.outputSchemaUrl === "string"
      ? submissionContract.outputSchemaUrl
      : undefined;

  const handleSubmit = async (evidence: string) => {
    setSubmitError(null);
    if (!loadedRow.sessionId) {
      setSubmitError("Claim this run before submitting evidence.");
      return;
    }
    setSubmitting(true);
    try {
      // The backend validates `payload.submission` directly against the
      // job's output schema (PR #123). If the operator typed a JSON
      // object that matches the schema, send it as-is. Otherwise fall
      // back to the legacy text-evidence wrapping so older fixtures
      // and free-text smoke tests still get a 4xx that says what's
      // wrong instead of failing silently here.
      const submission = parseSubmissionInput(evidence, loadedRow.id);
      await swrFetcher([
        "/jobs/submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: loadedRow.sessionId,
            submission,
          }),
        },
      ]);
      mutate("/jobs");
      mutate("/sessions");
    } catch (err) {
      // Surface the verifier's own message when it's an
      // `invalid_submission_shape` 422 — that's the new error code
      // PR #123 introduced and it carries an `expectedPath` hint that
      // tells the operator exactly which field is missing.
      const apiMessage = extractApiErrorMessage(err);
      setSubmitError(
        apiMessage ??
          "Could not submit this run. Check session ownership and the submission shape."
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
        : loadedOpenData
          ? "Loaded run · Open data dataset"
          : "Loaded run";

  return (
    <div className="flex flex-col gap-3.5">
      {/*
       * The standalone detail page (showLifecycle === true) is the
       * URL a browser-only agent receives when an upstream system
       * links into Averray. Render the plain-HTML semantic block at
       * the very top so the agent can scrape source / category /
       * state / reward / job ID without OCRing the panel below. The
       * queue page hides this block — it would just repeat the row
       * the operator already clicked.
       */}
      {showLifecycle ? <RunSemanticBlock row={loadedRow} /> : null}
      <LifecycleActionBar
        jobId={loadedRow.id}
        lifecycle={loadedRow.lifecycle}
      />
      <LoadedRunPanel
        kicker={kicker}
        title={loadedRow.title}
        meta={loadedRow.jobMeta}
        state={loadedRow.state}
        github={loadedGitHub}
        wikipedia={loadedWikipedia}
        osv={loadedOsv}
        openData={loadedOpenData}
        onReceiptPreview={() => setReceiptOpen(true)}
        standaloneUrl={standaloneUrl}
        stake={{
          amount: loadedRow.stake,
          aux: selectedJob
            ? `${selectedJob.rewardAsset ?? "DOT"} reward · verifier ${selectedJob.verifierMode ?? "unknown"}`
            : "waiting for live job definition",
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
          // Hint the operator that the textarea expects schema-shaped
          // JSON; the per-source SubmissionTabs override these labels
          // when a richer source-aware UI takes over.
          metaRight: outputSchemaUrl ? "schema-shaped JSON" : "",
          metaFoot: outputSchemaUrl ? `output schema · ${outputSchemaUrl}` : "",
          sample: submissionSample,
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
          ) : loadedOpenData ? (
            <>
              Submits{" "}
              <b className="text-[var(--avy-ink)]">checks + findings + recommended actions</b>{" "}
              to the verifier. Audit only — no edits to source data.
              Window{" "}
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
              : loadedOpenData
                ? "Submit audit report"
                : "Submit for verification",
          onSubmit: handleSubmit,
          submitting,
          error: submitError,
          // Gate the button on the live claim state. A row that's not
          // in `claimed` can't be submitted — either there's no claim
          // (claimable / expired / exhausted) or someone already
          // submitted (state: submitted). The string surfaces in the
          // disabled-button title and replaces the error line, so a
          // signed-out viewer sees "claim this run first" instead of
          // a useless 401 after clicking.
          disabledReason: !loadedRow.claim
            ? undefined
            : loadedRow.claim.state === "claimed"
              ? undefined
              : loadedRow.claim.state === "submitted"
                ? "Already submitted — awaiting verifier"
                : loadedRow.claim.state === "expired"
                  ? "Claim expired — reopen before submitting"
                  : loadedRow.claim.state === "exhausted"
                    ? "No retries left on this row"
                    : "Claim this run before submitting evidence",
        }}
        verifier={
          loadedOpenData
            ? {
                runner: "verifier-2 · open_data_quality_audit · handler-v0.14",
                elapsed: "stream · 2.8s",
                modeNote: "open_data_quality_audit · audit only",
                lines: [
                  {
                    time: "14:28:01",
                    level: "info",
                    label: "dataset",
                    message: (
                      <>
                        loaded{" "}
                        <span className="text-[#f4c989]">
                          {loadedOpenData.datasetTitle}
                        </span>
                        {loadedOpenData.agency
                          ? ` · ${loadedOpenData.agency}`
                          : null}
                      </>
                    ),
                  },
                  {
                    time: "14:28:01",
                    level: "ok",
                    label: "pass",
                    message: <>dataset URL reachable · landing page 200</>,
                  },
                  {
                    time: "14:28:02",
                    level: "ok",
                    label: "pass",
                    message: (
                      <>
                        resource URL reachable
                        {loadedOpenData.resourceFormat ? (
                          <>
                            {" · "}
                            <span className="text-[#9bd7b5]">
                              {loadedOpenData.resourceFormat}
                            </span>
                          </>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    time: "14:28:02",
                    level: "info",
                    label: "policy",
                    message: (
                      <>
                        audit-only path enforced ·{" "}
                        <span className="text-[#f4c989]">no source edits</span>
                      </>
                    ),
                  },
                  {
                    time: "14:28:03",
                    level: "warn",
                    label: "note",
                    message: (
                      <>
                        catalog metadata{" "}
                        <span className="text-[#f4c989]">stale</span> ·
                        recommendations attached
                      </>
                    ),
                  },
                  {
                    time: "14:28:03",
                    level: "ok",
                    label: "verdict",
                    message: (
                      <>
                        4/5 signals pass · receipt draft{" "}
                        <span className="text-[#f4c989]">r_4e133</span>
                      </>
                    ),
                  },
                ],
                verdict: {
                  status: "Audit complete (advisory)",
                  score: "4 / 5",
                  scoreLabel: "0.84 confidence",
                },
              }
            : loadedOsv
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
              : loadedOpenData
                ? "pays worker & verifier once the audit report verifies"
                : "pays worker & verifier once the maintainer approves the PR",
        }}
      />

      {showLifecycle ? (
        <LifecycleRail
          runId={loadedRow.id}
          contextNote={(() => {
            const verificationLabel =
              loadedWikipedia?.verification.method ??
              loadedOsv?.verification.method ??
              loadedOpenData?.verification.method ??
              "github_pr";
            const claim = loadedRow.claim;
            const deadlineLabel = claim?.claimExpiresAt
              ? formatDeadline(claim.claimExpiresAt)
              : "";
            const stateLabel = claim
              ? claim.state === "claimed"
                ? `claimed${claim.claimedBy ? ` ${describeClaimer(claim.claimedBy, undefined)}` : ""}`
                : claim.state === "submitted"
                  ? "submitted, awaiting verifier"
                  : claim.state === "expired"
                    ? "claim expired — reopenable"
                    : claim.state === "exhausted"
                      ? "no retries left"
                      : "ready to claim"
              : "no claim state";
            return (
              <>
                {deadlineLabel ? (
                  <>
                    Window{" "}
                    <b className="font-semibold text-[var(--avy-ink)]">{deadlineLabel}</b>
                    {" · "}
                  </>
                ) : null}
                verification{" "}
                <b className="font-semibold text-[var(--avy-ink)]">{verificationLabel}</b>
                {" · "}
                <b className="font-semibold text-[var(--avy-ink)]">{stateLabel}</b>
              </>
            );
          })()}
          stages={buildLifecycleStages({
            claim: loadedRow.claim,
            source: loadedRow.source,
          })}
          next={{
            label: "Next",
            value: loadedWikipedia
              ? "Averray review → Pay"
              : loadedOsv
                ? "Maintainer merge → Pay"
                : loadedOpenData
                  ? "Verifier check → Pay"
                  : "Maintainer review → Pay",
            sub: loadedWikipedia
              ? "auto-pays on Averray-approved review"
              : loadedOsv
                ? "auto-pays on PR merge + CI green + lockfile resolves"
                : loadedOpenData
                  ? "auto-pays on audit verifier signals green"
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
          loadedOsv,
          loadedOpenData
        )}
      />
    </div>
  );
}

/**
 * Read an operator's textarea content as a submission body. Two paths:
 *   - JSON-object input → forward verbatim as `payload.submission`. This
 *     is the supported shape after PR #123: the verifier validates this
 *     object directly against the job's output schema.
 *   - Anything else → wrap in the legacy `{ evidence, jobId, submittedAt }`
 *     shape so older smoke tests and free-text scratch input get a
 *     useful 4xx from the verifier (with `expectedPath`) rather than
 *     failing silently in the client.
 */
function parseSubmissionInput(evidence: string, jobId: string): unknown {
  const trimmed = evidence.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to the wrapped form below.
    }
  }
  return {
    evidence,
    jobId,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Lift the human-friendly verifier message off an ApiError 4xx body so
 * the operator sees `invalid_submission_shape · expectedPath ...`
 * instead of a generic "could not submit" string. Returns undefined for
 * non-API errors so the caller can substitute its own copy.
 */
function extractApiErrorMessage(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const message =
      typeof record.message === "string" ? record.message : undefined;
    const expected =
      typeof record.expectedPath === "string"
        ? record.expectedPath
        : typeof (record.details as Record<string, unknown> | undefined)?.expectedPath ===
            "string"
          ? ((record.details as Record<string, unknown>).expectedPath as string)
          : undefined;
    if (message || code) {
      const parts = [code, message].filter(
        (p): p is string => typeof p === "string" && p.length > 0
      );
      const combined = parts.join(" · ");
      return expected ? `${combined} · expected ${expected}` : combined;
    }
  }
  return err.message;
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
  osv: ReturnType<typeof buildOsvContext>,
  openData: ReturnType<typeof buildOpenDataContext>
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
        : openData
          ? {
              status: "Audit complete (advisory)",
              score: "4 / 5",
              confidence: "0.84 confidence",
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
        : openData
          ? "Verifier · audit signed"
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
    ...(openData ? { openData } : {}),
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
