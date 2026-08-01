"use client";

import { useMemo, useState } from "react";
import { FundingFlow } from "@/components/poster/FundingFlow";
import { ApiError } from "@/lib/api/client";
import { buildDefinition, postDraft, type DraftFormInput } from "@/lib/api/poster-post";
import { parseUsdcToRaw } from "@/lib/wallet/funding";
import { cn } from "@/lib/utils/cn";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const FIELD =
  "rounded-[8px] border border-[var(--avy-line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)] outline-none focus:border-[var(--avy-accent)]";
const LABEL =
  "font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]";

/**
 * C2: draft form → server-issued calldata → wallet signing. The form only
 * collects the poster's inputs; every derived value (specHash, jobId,
 * calldata, fee) comes from the server and chain, gated in FundingFlow.
 */
export function NewBountyPanel({
  onboarding,
  wallet,
}: {
  onboarding: unknown;
  wallet: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [reward, setReward] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<unknown>(null);
  const [submittedRewardRaw, setSubmittedRewardRaw] = useState<bigint | null>(null);
  const [error, setError] = useState<{ status: number | null; message: string } | null>(null);

  const onboardingRecord = asRecord(onboarding);
  const economics = asRecord(onboardingRecord.economics);
  const minReward =
    typeof economics.minRewardUsdc === "string" || typeof economics.minRewardUsdc === "number"
      ? String(economics.minRewardUsdc)
      : null;
  const minRewardRaw = minReward ? parseUsdcToRaw(minReward) : null;

  const rewardRaw = useMemo(() => parseUsdcToRaw(reward), [reward]);
  const criteriaList = useMemo(
    () =>
      criteria
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [criteria]
  );
  const formValid =
    task.trim().length >= 10 &&
    repo.trim().length >= 3 &&
    criteriaList.length >= 1 &&
    rewardRaw !== null &&
    (minRewardRaw === null || rewardRaw >= minRewardRaw);

  async function submit() {
    if (!formValid || rewardRaw === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const input: DraftFormInput = {
        title,
        task,
        repo,
        acceptanceCriteria: criteriaList,
        rewardUsdc: reward.trim(),
      };
      const response = await postDraft(buildDefinition(input));
      setDraft(response);
      setSubmittedRewardRaw(rewardRaw);
    } catch (err) {
      if (err instanceof ApiError) {
        setError({
          status: err.status,
          message:
            err.status === 403
              ? "This wallet is not on the posting allowlist — enrollment is the door's honest gate. Contact the operator to enroll, then retry."
              : err.message,
        });
      } else {
        setError({ status: null, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!wallet) {
    return (
      <p className="font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-muted)]">
        Sign in with your poster wallet to create a draft.
      </p>
    );
  }

  if (draft && submittedRewardRaw !== null) {
    const draftRecord = asRecord(draft);
    return (
      <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-0.5">
          <span className={LABEL} style={{ letterSpacing: "0.1em" }}>
            Draft created
          </span>
          <span className="break-all font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]">
            {String(draftRecord.draftId ?? "")}
          </span>
        </div>
        <FundingFlow
          draft={draft}
          onboarding={onboarding}
          expectedRewardRaw={submittedRewardRaw}
          wallet={wallet}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-start rounded-[8px] border border-[var(--avy-accent)] bg-[var(--avy-accent-soft)] px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.1em" }}
        >
          New bounty draft
        </button>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
              Task (what the worker delivers)
            </label>
            <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} className={FIELD} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
                Repository (owner/name)
              </label>
              <input value={repo} onChange={(e) => setRepo(e.target.value)} className={FIELD} spellCheck={false} />
            </div>
            <div className="flex flex-col gap-1">
              <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
                Reward (USDC{minReward ? `, ≥ ${minReward}` : ""})
              </label>
              <input value={reward} onChange={(e) => setReward(e.target.value)} className={FIELD} inputMode="decimal" spellCheck={false} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
              Acceptance criteria (one per line — you approve against exactly these)
            </label>
            <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} className={FIELD} />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
              Title (optional)
            </label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!formValid || submitting}
              className={cn(
                "rounded-[8px] border px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase",
                formValid && !submitting
                  ? "border-[var(--avy-accent)] bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
                  : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-muted)]"
              )}
              style={{ letterSpacing: "0.1em" }}
            >
              {submitting ? "Creating draft…" : "Create draft (no funds move)"}
            </button>
            <span className="font-[family-name:var(--font-body)] text-[11.5px] text-[var(--avy-muted)]">
              Verifier: human review (you approve) · claim TTL 24h · schema coding-input
            </span>
          </div>
          {error ? (
            <p className="text-[12.5px] text-[#b22222]">
              {error.message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
