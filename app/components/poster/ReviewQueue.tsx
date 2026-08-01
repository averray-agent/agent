"use client";

import { useState } from "react";
import { mutate } from "swr";
import { ExplorerLink } from "@/components/common/ExplorerLink";
import { useApi } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";
import {
  buildDecisionResult,
  buildSubmissionView,
  deadlineLabel,
  postReview,
  type DecisionResult,
} from "@/lib/api/poster-review";
import type { PosterJobRow } from "@/lib/api/poster-adapters";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils/cn";

const MONO = "font-[family-name:var(--font-mono)]";
const LABEL =
  "font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * C3: the poster's review queue. Each card is a submitted external job of
 * the signed-in poster; the deliverable comes from the poster-scoped
 * submission endpoint and the acceptance criteria from the job's own public
 * definition — shown verbatim, because that is what the poster approves
 * against. Decisions call POST /jobs/:id/review; every outcome (settled tx,
 * rejection window, refusal because escalation owns it) renders as the API
 * reports it.
 */
export function ReviewQueue({ rows }: { rows: PosterJobRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5">
      <h2
        className="font-[family-name:var(--font-display)] text-[12px] font-extrabold uppercase text-[var(--avy-ink)]"
        style={{ letterSpacing: "0.1em" }}
      >
        Needs your review
        <span className="ml-2 rounded-full border border-[var(--avy-warn)] bg-[var(--avy-warn-soft)] px-2 py-0.5 text-[10px] text-[var(--avy-ink)]">
          {rows.length}
        </span>
      </h2>
      {rows.map((row) => (
        <ReviewCard key={row.id} row={row} />
      ))}
    </section>
  );
}

function ReviewCard({ row }: { row: PosterJobRow }) {
  const submissionRequest = useApi<Record<string, unknown>>(
    `/jobs/${encodeURIComponent(row.id)}/submission`,
    { refreshInterval: 15_000 }
  );
  const definitionRequest = useApi<Record<string, unknown>>(
    `/jobs/definition?jobId=${encodeURIComponent(row.id)}`
  );
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const view = submissionRequest.data ? buildSubmissionView(submissionRequest.data) : null;
  const definition = asRecord(asRecord(definitionRequest.data).definition ?? definitionRequest.data);
  const criteria = Array.isArray(definition.acceptanceCriteria)
    ? definition.acceptanceCriteria.filter((item): item is string => typeof item === "string")
    : [];
  const status =
    submissionRequest.error instanceof ApiError ? submissionRequest.error.status : null;
  const deadline = view ? deadlineLabel(view.deadline) : null;

  async function decide(verdict: "approve" | "reject") {
    setBusy(verdict);
    setError(null);
    try {
      const response = await postReview(row.id, verdict, reason.trim());
      setResult(buildDecisionResult(response));
      void mutate("/jobs?source=external&limit=100");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-[family-name:var(--font-body)] text-[14px] font-semibold text-[var(--avy-ink)]">
            {row.title}
          </span>
          <span className={cn("text-[11.5px] text-[var(--avy-muted)]", MONO)}>
            {view?.worker ? `worker ${shortAddress(view.worker)}` : "worker —"}
            {view?.submittedAt ? ` · submitted ${view.submittedAt.slice(0, 16).replace("T", " ")}` : ""}
          </span>
        </div>
        {deadline ? (
          <span className="rounded-full border border-[var(--avy-warn)] bg-[var(--avy-warn-soft)] px-2.5 py-0.5 font-[family-name:var(--font-body)] text-[11.5px] text-[var(--avy-ink)]">
            {deadline}
          </span>
        ) : null}
      </div>

      {status === 401 || status === 403 || status === 404 ? (
        <p className="font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-ink)]">
          The submission is visible only to this job's poster — sign in with
          the posting wallet.
        </p>
      ) : submissionRequest.isLoading ? (
        <p className={cn("text-[12px] text-[var(--avy-muted)]", MONO)}>Loading submission…</p>
      ) : view ? (
        <div className="flex flex-col gap-1.5 rounded-[8px] border border-[var(--avy-line-soft)] bg-[#faf8f1] p-3">
          <span className={LABEL} style={{ letterSpacing: "0.1em" }}>
            The deliverable
          </span>
          {view.deliverableUrl ? (
            <a
              href={view.deliverableUrl}
              target="_blank"
              rel="noreferrer"
              className={cn("break-all text-[13px] font-semibold text-[var(--avy-accent)] hover:underline", MONO)}
            >
              {view.deliverableUrl}
            </a>
          ) : null}
          {view.deliverableText ? (
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-ink)]">
              {view.deliverableText}
            </p>
          ) : !view.deliverableUrl ? (
            <p className={cn("text-[12px] text-[var(--avy-muted)]", MONO)}>
              Submission recorded; no renderable payload fields — inspect via
              the API before deciding.
            </p>
          ) : null}
          {criteria.length > 0 ? (
            <>
              <span className={LABEL} style={{ letterSpacing: "0.1em" }}>
                Your acceptance criteria — decide against exactly these
              </span>
              <ul className="list-disc pl-5">
                {criteria.map((item) => (
                  <li key={item} className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-ink)]">
                    {item}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-1">
          <p
            className={cn(
              "text-[13px] font-semibold",
              result.decision === "approve" ? "text-[#1e6642]" : "text-[var(--avy-ink)]"
            )}
          >
            {result.decision === "approve"
              ? "Approved — the worker is paid and their bond released."
              : "Rejected — the worker's dispute window is now running."}
          </p>
          {result.txHash ? (
            <span className={cn("text-[12px]", MONO)}>
              settlement: <ExplorerLink kind="tx" value={result.txHash} />
            </span>
          ) : null}
        </div>
      ) : view && view.reviewStatus === "awaiting_decision" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide("approve")}
              className={cn(
                "rounded-[8px] border px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase",
                busy === null
                  ? "border-[rgba(30,102,66,0.45)] bg-[rgba(30,102,66,0.08)] text-[#1e6642]"
                  : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-muted)]"
              )}
              style={{ letterSpacing: "0.1em" }}
            >
              {busy === "approve" ? "Approving…" : `Approve — pay ${row.rewardLabel ?? "the reward"}`}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setRejecting((value) => !value)}
              className="rounded-[8px] border border-[var(--avy-line)] bg-[#faf8f1] px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-ink)]"
              style={{ letterSpacing: "0.1em" }}
            >
              Reject with reason
            </button>
            <span className="font-[family-name:var(--font-body)] text-[11.5px] text-[var(--avy-muted)]">
              approve settles from your escrow · reject starts the worker's dispute window
            </span>
          </div>
          {rejecting ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why the submission fails your criteria (recorded and hashed)"
                className="min-w-[320px] flex-1 rounded-[8px] border border-[var(--avy-line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-ink)] outline-none focus:border-[var(--avy-accent)]"
              />
              <button
                type="button"
                disabled={busy !== null || reason.trim().length < 20}
                onClick={() => void decide("reject")}
                className={cn(
                  "rounded-[8px] border px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase",
                  reason.trim().length >= 20 && busy === null
                    ? "border-[rgba(178,34,34,0.45)] bg-[rgba(178,34,34,0.06)] text-[#b22222]"
                    : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-muted)]"
                )}
                style={{ letterSpacing: "0.1em" }}
              >
                {busy === "reject" ? "Rejecting…" : "Confirm rejection"}
              </button>
            </div>
          ) : null}
        </div>
      ) : view ? (
        <p className={cn("text-[12px] text-[var(--avy-muted)]", MONO)}>
          review status: {view.reviewStatus} — no decision available here.
        </p>
      ) : null}

      {error ? <p className="break-all text-[12.5px] text-[#b22222]">{error}</p> : null}
    </div>
  );
}
