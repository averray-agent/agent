"use client";

import { useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { LoadedRunPanel, type VerifierOutputView } from "./LoadedRunPanel";
import { LifecycleRail } from "./LifecycleRail";
import { JobTimelinePanel } from "./JobTimelinePanel";
import { JobLineagePanel } from "./JobLineagePanel";
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
import {
  useBadge,
  useAdminJobs,
  useJobDefinition,
  useJobPreflight,
  useJobs,
  useJobTimeline,
  useSession,
  useSessionTimeline,
  useVerifierResult,
} from "@/lib/api/hooks";
import { feedPresence } from "@/lib/api/feed-presence";
import { buildJobTimeline } from "@/lib/api/job-timeline";
import {
  buildGitHubContext,
  buildOpenDataContext,
  buildOsvContext,
  buildRunRows,
  buildWikipediaContext,
  extractRunJobs,
} from "@/lib/api/run-adapters";
import { extractAdminJobs } from "@/lib/api/job-lifecycle";
import { extractClaimStatus } from "@/lib/api/claim-status";
import {
  extractJobSchemaContract,
  extractSubmissionContract,
  extractSubmissionExample,
  validationPath,
  validationStateFromPayload,
  type JobSchemaContract,
  type SubmissionContract,
  type SubmissionValidationState,
} from "@/lib/api/submission-contract";
import { runGuardedSubmit } from "@/lib/api/guarded-submit";
import { buildVerifierOutput } from "@/lib/api/verifier-output";

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
  // The timeline panel below the rail already fetches this; SWR
  // dedupes by URL key so calling the hook here is free and lets
  // the rail tint stages from the same v2-envelope severity events
  // the panel renders.
  const timelineRequest = useJobTimeline(runId);
  const timelineData = useMemo(
    () => buildJobTimeline(timelineRequest.data),
    [timelineRequest.data]
  );
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
  const jobPreflight = useJobPreflight(loadedRow?.id ?? null);
  const selectedJob = loadedRow
    ? asRecord(jobDefinition.data) ?? rawJobs.find((job) => job.id === loadedRow.id)
    : undefined;
  const loadedGitHub = loadedRow ? buildGitHubContext(loadedRow, selectedJob) : undefined;
  const loadedWikipedia = loadedRow ? buildWikipediaContext(loadedRow, selectedJob) : undefined;
  const loadedOsv = loadedRow ? buildOsvContext(loadedRow, selectedJob) : undefined;
  const loadedOpenData = loadedRow ? buildOpenDataContext(loadedRow, selectedJob) : undefined;
  const claimStatus = useMemo(() => extractClaimStatus(selectedJob), [selectedJob]);
  const selectedSessionId =
    loadedRow?.sessionId ??
    claimStatus?.sessionId ??
    timelineData.summary.activeSessionIds[0] ??
    timelineData.summary.terminalSessionIds[0] ??
    null;
  const session = useSession(selectedSessionId);
  const sessionTimeline = useSessionTimeline(selectedSessionId);
  const verifierResult = useVerifierResult(selectedSessionId);
  const badge = useBadge(selectedSessionId);
  const actualVerifierMode = text(selectedJob?.verifierMode);
  const verifierOutput = useMemo<VerifierOutputView>(
    () =>
      buildVerifierOutput({
        sessionId: selectedSessionId ?? undefined,
        verifierMode: actualVerifierMode,
        claimState: loadedRow?.claim?.state ?? claimStatus?.state,
        sessionPayload: session.data,
        sessionPresence: feedPresence(session),
        sessionTimelinePayload: sessionTimeline.data,
        sessionTimelinePresence: feedPresence(sessionTimeline),
        verifierResultPayload: verifierResult.data,
        verifierResultPresence: feedPresence(verifierResult),
        badgePayload: badge.data,
        badgePresence: feedPresence(badge),
        jobTimeline: timelineData,
        jobTimelinePresence: feedPresence(timelineRequest),
      }) as VerifierOutputView,
    [
      actualVerifierMode,
      badge,
      claimStatus?.state,
      loadedRow?.claim?.state,
      selectedSessionId,
      session,
      sessionTimeline,
      timelineData,
      timelineRequest,
      verifierResult,
    ]
  );
  const receiptDraft =
    loadedRow && verifierOutput.kind === "terminal"
      ? buildReceiptDraft(
          loadedRow,
          verifierOutput,
          badge.data,
          selectedJob,
          loadedGitHub,
          loadedWikipedia,
          loadedOsv,
          loadedOpenData
        )
      : null;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validatingDraft, setValidatingDraft] = useState(false);
  const [validationState, setValidationState] = useState<SubmissionValidationState>({
    status: "not_checked",
  });
  const [receiptOpen, setReceiptOpen] = useState(false);

  useEffect(() => {
    setValidationState({ status: "not_checked" });
    setSubmitError(null);
  }, [loadedRow?.id]);

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
  const preflightRecord = asRecord(jobPreflight.data);
  const submissionContract = extractSubmissionContract(selectedJob, preflightRecord);
  const schemaContract = extractJobSchemaContract(selectedJob, preflightRecord);
  const submissionExample = extractSubmissionExample(submissionContract);
  const submissionSample = submissionExample
    ? JSON.stringify(submissionExample, null, 2)
    : "";
  const outputSchemaUrl =
    typeof submissionContract?.outputSchemaUrl === "string"
      ? submissionContract.outputSchemaUrl
      : undefined;
  const structuredSubmissionRequired =
    submissionContract?.structuredSubmissionRequired === true;

  const handleValidateDraft = async (draft: string) => {
    setValidatingDraft(true);
    setSubmitError(null);
    try {
      const submission = parseDirectSubmissionDraft(draft);
      const result = await swrFetcher([
        "/jobs/validate-submission",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jobId: loadedRow.id,
            submission,
          }),
        },
      ]);
      setValidationState(validationStateFromPayload(result));
    } catch (err) {
      setValidationState(validationStateFromError(err));
    } finally {
      setValidatingDraft(false);
    }
  };

  const handleSubmit = async (evidence: string) => {
    setSubmitError(null);
    if (!loadedRow.sessionId) {
      setSubmitError("Claim this run before submitting evidence.");
      return;
    }
    setSubmitting(true);
    try {
      const submission = structuredSubmissionRequired
        ? parseDirectSubmissionDraft(evidence)
        : parseSubmissionInput(evidence, loadedRow.id);
      // Guarded path for schema-required jobs: validate first against
      // /jobs/validate-submission and refuse to fire /jobs/submit when
      // the draft is invalid. Keeps a failed-validation attempt from
      // consuming the operator's claim/submit budget.
      const outcome = await runGuardedSubmit({
        jobId: loadedRow.id,
        sessionId: loadedRow.sessionId,
        submission,
        structuredSubmissionRequired,
        fetcher: swrFetcher,
      });
      if (outcome.status === "validation_failed") {
        setValidationState(validationStateFromPayload(outcome.validation));
        setSubmitError("Draft did not match the output schema. Fix the highlighted path and submit again.");
        return;
      }
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
          (err instanceof Error ? err.message : undefined) ??
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
      {submissionContract ? (
        <SubmissionReadinessStrip
          contract={submissionContract}
          schemaContract={schemaContract}
          preflight={preflightRecord}
        />
      ) : null}
      <LoadedRunPanel
        kicker={kicker}
        title={loadedRow.title}
        meta={loadedRow.jobMeta}
        state={loadedRow.state}
        github={loadedGitHub}
        wikipedia={loadedWikipedia}
        osv={loadedOsv}
        openData={loadedOpenData}
        onReceiptPreview={receiptDraft ? () => setReceiptOpen(true) : undefined}
        standaloneUrl={standaloneUrl}
        stake={{
          amount: loadedRow.stake,
          currency: rewardAssetFor(selectedJob, badge.data),
          aux: selectedJob
            ? `${rewardAssetFor(selectedJob, badge.data)} reward · verifier ${actualVerifierMode || "unknown"}`
            : "waiting for live job definition",
          breakdown: {
            worker: `${loadedRow.stake} ${rewardAssetFor(selectedJob, badge.data)}`,
            verifier: `0 ${rewardAssetFor(selectedJob, badge.data)}`,
            treasury: `0 ${rewardAssetFor(selectedJob, badge.data)}`,
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
        submissionContract={
          submissionContract
            ? {
                endpoint: text(submissionContract.endpoint),
                validationEndpoint: text(submissionContract.validationEndpoint),
                structuredSubmissionRequired:
                  submissionContract.structuredSubmissionRequired === true,
                schemaValidates: text(submissionContract.schemaValidates),
                doNotWrapInOutput: submissionContract.doNotWrapInOutput === true,
                outputSchemaRef: text(submissionContract.outputSchemaRef),
                outputSchemaUrl: text(submissionContract.outputSchemaUrl),
                submitPayloadExample: submissionContract.submitPayloadExample,
                invalidWrappedOutputHint: text(
                  submissionContract.invalidWrappedOutputHint
                ),
                schemaContract,
                validation: validationState,
                validating: validatingDraft,
                onValidate: handleValidateDraft,
              }
            : undefined
        }
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
        verifier={verifierOutput}
        settle={buildSettlementView(loadedRow, verifierOutput, badge.data, selectedJob)}
      />

      {showLifecycle ? (
        <LifecycleRail
          runId={loadedRow.id}
          contextNote={(() => {
            const verificationLabel = actualVerifierMode || "unknown";
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
            timeline: timelineData.timeline,
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

      {/* Sub-job lineage panel — closes CORE_FRAMEWORK_ROADMAP §8.
       *  Reads the same /admin/jobs/timeline payload the timeline
       *  panel uses (SWR dedupes), so this is a free second
       *  consumer. Sits above the timeline so the operator sees
       *  parent / children / recurring relationships before the
       *  full chronological log. */}
      {showLifecycle ? <JobLineagePanel jobId={loadedRow.id} /> : null}

      {/* Job timeline (PR #149) — full chronological log of every
       *  event the backend has stitched for this job: state
       *  transitions, verifier outcomes, child-run lineage, recurring
       *  derivatives, raw event-bus rows. Only on the standalone
       *  detail page (showLifecycle === true); the queue page already
       *  has the rail above the sticky pane. */}
      {showLifecycle ? <JobTimelinePanel jobId={loadedRow.id} /> : null}

      {receiptDraft ? (
        <ReceiptPreviewDrawer
          open={receiptOpen}
          onClose={() => setReceiptOpen(false)}
          draft={receiptDraft}
        />
      ) : null}
    </div>
  );
}

function SubmissionReadinessStrip({
  contract,
  schemaContract,
  preflight,
}: {
  contract: SubmissionContract;
  schemaContract: JobSchemaContract | null;
  preflight: Record<string, unknown> | null;
}) {
  const output = asRecord(schemaContract?.output);
  const endpoint = text(
    contract.validationEndpoint,
    text(output?.validationEndpoint, "POST /jobs/validate-submission")
  );
  const schemaRef = text(
    contract.outputSchemaRef,
    text(output?.schemaRef, text(preflight?.requiredOutputSchema, "not emitted"))
  );
  const schemaUrl = text(contract.outputSchemaUrl, text(output?.schemaUrl, ""));
  const validates = text(
    contract.schemaValidates,
    text(output?.validates, "payload.submission")
  );
  const structured = contract.structuredSubmissionRequired === true;

  return (
    <section className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[0.75rem_0.95rem] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.14em" }}
        >
          Preflight submission readiness
        </span>
        <ReadinessFact
          label="structuredSubmissionRequired"
          value={structured ? "true" : "false"}
          accent={structured}
        />
        <ReadinessFact label="outputSchemaRef" value={schemaRef} href={schemaUrl} />
        <ReadinessFact label="validationEndpoint" value={endpoint} />
        <ReadinessFact label="validates" value={validates} />
      </div>
    </section>
  );
}

function ReadinessFact({
  label,
  value,
  href,
  accent = false,
}: {
  label: string;
  value: string;
  href?: string;
  accent?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="text-[var(--avy-muted)]">{label}</span>
      <b
        className={`min-w-0 break-words font-semibold ${
          accent ? "text-[var(--avy-accent)]" : "text-[var(--avy-ink)]"
        }`}
      >
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--avy-accent)] hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </b>
    </span>
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

function parseDirectSubmissionDraft(draft: string): unknown {
  const trimmed = draft.trim();
  if (!trimmed) {
    throw new Error("Draft is empty. Paste the schema object for payload.submission.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid JSON draft: ${error.message}`
        : "Invalid JSON draft."
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload.submission must be a JSON object.");
  }
  return parsed;
}

function validationStateFromError(err: unknown): SubmissionValidationState {
  if (err instanceof ApiError) {
    const record = asRecord(err.body);
    return {
      status: "invalid",
      message: record ? text(record.message, err.message) : err.message,
      path: record ? validationPath(record) : undefined,
      details: record?.details ?? err.body,
    };
  }
  return {
    status: "invalid",
    message: err instanceof Error ? err.message : "Could not validate draft.",
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

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function buildSettlementView(
  row: RunRow,
  verifier: VerifierOutputView,
  badgePayload: unknown,
  selectedJob: Record<string, unknown> | undefined
) {
  const asset = rewardAssetFor(selectedJob, badgePayload);
  if (verifier.kind === "terminal") {
    return {
      title: "Verifier result recorded",
      detail: (
        <>
          Verdict <b className="text-[var(--avy-ink)]">{verifier.verdict.status}</b>{" "}
          · receipt <b className="text-[var(--avy-ink)]">{verifier.receiptRef}</b>
        </>
      ),
      cta: "Settle from result",
      ctaDisabled: true,
      note: `uses ${asset} reward and public badge metadata`,
    };
  }
  if (verifier.kind === "locked") {
    return {
      title: "Verifier log locked",
      detail: verifier.message,
      cta: "Settle from result",
      ctaDisabled: true,
      note: "operator role required",
    };
  }
  if (verifier.kind === "awaiting") {
    return {
      title: "Awaiting verification",
      detail: "No receipt has been issued yet.",
      cta: "Settle from result",
      ctaDisabled: true,
      note: "settlement unlocks after a real verifier verdict",
    };
  }
  return {
    title: "No verifier result",
    detail:
      row.sessionId || row.claim?.state === "claimed"
        ? "Evidence has not produced a verifier result yet."
        : "This run has not been claimed.",
    cta: "Settle from result",
    ctaDisabled: true,
    note: "settlement requires a real verifier receipt",
  };
}

function buildReceiptDraft(
  row: RunRow,
  verifier: Extract<VerifierOutputView, { kind: "terminal" }>,
  badgePayload: unknown,
  selectedJob: Record<string, unknown> | undefined,
  github: ReturnType<typeof buildGitHubContext>,
  wikipedia: ReturnType<typeof buildWikipediaContext>,
  osv: ReturnType<typeof buildOsvContext>,
  openData: ReturnType<typeof buildOpenDataContext>
): ReceiptPreviewDraft | null {
  const badgeAverray = asRecord(asRecord(badgePayload)?.averray);
  const receiptRef = verifier.receiptRef;
  if (!receiptRef) return null;

  const workerSignerLabel = row.worker.isSelf
    ? `Worker · ${row.worker.label} (you)`
    : `Worker · ${row.worker.label}`;
  const asset = rewardAssetFor(selectedJob, badgePayload);
  const reward = asRecord(badgeAverray?.reward);
  const claimStake = asRecord(badgeAverray?.claimStake);
  const rewardAmount = formatBadgeAmount(reward?.amount, reward?.decimals) ?? row.stake;
  const stakeRows = [
    { label: "Worker reward", value: `${rewardAmount} ${asset}` },
  ];
  const claimStakeAmount = formatBadgeAmount(claimStake?.amount, claimStake?.decimals);
  if (claimStakeAmount) {
    stakeRows.push({ label: "Claim stake", value: `${claimStakeAmount} ${asset}` });
  }
  const signers = [
    { label: workerSignerLabel, status: "signed" as const },
    ...signerFromBadge("Poster", badgeAverray?.poster),
    ...signerFromBadge("Verifier", badgeAverray?.verifier),
  ];

  return {
    receiptRef,
    runId: row.id,
    jobMeta: row.jobMeta,
    state: row.state,
    stake: {
      amount: rewardAmount,
      currency: asset,
      breakdown: stakeRows,
    },
    verdict: {
      status: verifier.verdict.status,
      score: verifier.reasonCode || verifier.verdict.score,
      detail: receiptRef,
    },
    evidenceHash: verifier.evidenceHash,
    ...(github ? { github } : {}),
    ...(wikipedia ? { wikipedia } : {}),
    ...(osv ? { osv } : {}),
    ...(openData ? { openData } : {}),
    signers,
  };
}

function rewardAssetFor(
  selectedJob: Record<string, unknown> | undefined,
  badgePayload: unknown
): string {
  const badgeAverray = asRecord(asRecord(badgePayload)?.averray);
  const reward = asRecord(badgeAverray?.reward);
  return text(selectedJob?.rewardAsset, text(reward?.asset, "USDC"));
}

function formatBadgeAmount(value: unknown, decimalsValue: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9]+$/u.test(raw)) return null;
  const decimals = Number(decimalsValue);
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return Number(raw).toLocaleString("en-US");
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/u, "");
  const valueNumber = Number(`${whole}.${fractional || "0"}`);
  if (!Number.isFinite(valueNumber)) return `${whole}${fractional ? `.${fractional}` : ""}`;
  return valueNumber.toLocaleString("en-US", {
    minimumFractionDigits: valueNumber > 0 && valueNumber < 10 ? 2 : 0,
    maximumFractionDigits: Math.min(decimals, 6),
  });
}

function signerFromBadge(label: string, value: unknown) {
  const raw = text(value);
  if (!raw || /^0x0{40}$/iu.test(raw)) return [];
  return [{ label: `${label} · ${shortAddress(raw)}`, status: "signed" as const }];
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
