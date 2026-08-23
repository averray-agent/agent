"use client";

import { useMemo, useState } from "react";
import { FundingFlow } from "@/components/poster/FundingFlow";
import { ApiError } from "@/lib/api/client";
import { buildDefinition, postDraft, type DraftFormInput } from "@/lib/api/poster-post";
import { verifierDisclosureForDeliverable } from "@/lib/api/poster-definition";
import { estimateWorkerBondRaw } from "@/lib/api/poster-adapters";
import {
  fetchIssue,
  parseIssueUrl,
  seedTemplate,
  type DeliverableKind,
  type IssueLookup,
  type ParsedIssueUrl,
} from "@/lib/github/issue";
import { formatRawUsdc, parseUsdcToRaw } from "@/lib/wallet/funding";
import { cn } from "@/lib/utils/cn";
import { PostingStepper } from "@/components/poster/PostingStepper";
import { activePostingStep } from "@/lib/ui/mobile-operator.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const FIELD =
  "min-h-11 rounded-[8px] border border-[var(--avy-line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)] outline-none focus:border-[var(--avy-accent)] min-[1080px]:min-h-0";
const LABEL =
  "font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]";
const MONO = "font-[family-name:var(--font-mono)]";

function StepHeading({ step, title, done }: { step: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-full border font-[family-name:var(--font-display)] text-[10px] font-extrabold",
          done
            ? "border-[rgba(30,102,66,0.4)] bg-[rgba(30,102,66,0.1)] text-[#1e6642]"
            : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-ink)]"
        )}
      >
        {done ? "✓" : step}
      </span>
      <span className={LABEL} style={{ letterSpacing: "0.1em" }}>
        {title}
      </span>
    </div>
  );
}

function primaryButton(enabled: boolean) {
  return cn(
    "min-h-11 rounded-[8px] border px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase min-[1080px]:min-h-0",
    enabled
      ? "border-[var(--avy-accent)] bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
      : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-muted)]"
  );
}

/**
 * The issue-anchored posting wizard. Every bounty starts from a verified
 * public GitHub issue — the URL is the input; repo, title, task, and
 * acceptance criteria derive from it (editable). Economics render live
 * from /poster/onboarding BEFORE anything is created, including what the
 * worker must lock. The final step shows exactly what a worker will see.
 */
export function NewBountyPanel({
  onboarding,
  wallet,
}: {
  onboarding: unknown;
  wallet: string | null;
}) {
  // Step 1 — issue anchor
  const [url, setUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [parsed, setParsed] = useState<ParsedIssueUrl | null>(null);
  const [lookup, setLookup] = useState<IssueLookup | null>(null);
  // Step 2 — deliverable
  const [kind, setKind] = useState<DeliverableKind | null>(null);
  const [task, setTask] = useState("");
  const [criteria, setCriteria] = useState("");
  const [title, setTitle] = useState("");
  // Step 3 — reward
  const [reward, setReward] = useState("");
  const [mobileStep, setMobileStep] = useState(1);
  // Step 4 — draft + funding
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<unknown>(null);
  const [submittedRewardRaw, setSubmittedRewardRaw] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onboardingRecord = asRecord(onboarding);
  const economics = asRecord(onboardingRecord.economics);
  const workerFacts = asRecord(onboardingRecord.workerFacts);
  const feeBps =
    typeof economics.protocolFeeBps === "number"
      ? economics.protocolFeeBps
      : typeof asRecord(economics.protocolFeeBps).value === "number"
        ? (asRecord(economics.protocolFeeBps).value as number)
        : null;
  const minReward =
    typeof economics.minRewardUsdc === "string" || typeof economics.minRewardUsdc === "number"
      ? String(economics.minRewardUsdc)
      : null;
  const minRewardRaw = minReward ? parseUsdcToRaw(minReward) : null;

  const issueVerified = lookup?.ok === true && !lookup.isPullRequest;
  const rewardRaw = useMemo(() => parseUsdcToRaw(reward), [reward]);
  const rewardOk = rewardRaw !== null && (minRewardRaw === null || rewardRaw >= minRewardRaw);
  const reserveRaw =
    rewardRaw !== null && feeBps !== null ? rewardRaw + (rewardRaw * BigInt(feeBps)) / 10_000n : null;
  const bondRaw =
    rewardRaw !== null ? estimateWorkerBondRaw(rewardRaw, workerFacts.claimBond) : null;
  const criteriaList = useMemo(
    () => criteria.split("\n").map((line) => line.trim()).filter(Boolean),
    [criteria]
  );
  const contentOk = task.trim().length >= 10 && criteriaList.length >= 1;
  const availableStep = activePostingStep({
    issueVerified,
    deliverableChosen: kind !== null,
    contentReady: contentOk,
    rewardReady: rewardOk,
  });
  const currentStep = Math.min(mobileStep, availableStep);

  async function verifyIssue() {
    const next = parseIssueUrl(url);
    setMobileStep(1);
    setParsed(next);
    setLookup(null);
    setKind(null);
    if (!next) return;
    setChecking(true);
    const result = await fetchIssue(next);
    setLookup(result);
    if (result.ok && !result.isPullRequest) setMobileStep(2);
    setChecking(false);
  }

  function chooseKind(next: DeliverableKind) {
    if (!parsed || !lookup?.ok) return;
    setKind(next);
    const seeded = seedTemplate(next, {
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      title: lookup.title,
    });
    setTask(seeded.task);
    setCriteria(seeded.criteria.join("\n"));
    setTitle(seeded.title);
  }

  async function submit() {
    if (!parsed || !kind || !issueVerified || !contentOk || !rewardOk || rewardRaw === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const input: DraftFormInput = {
        deliverableKind: kind,
        title,
        task,
        repo: `${parsed.owner}/${parsed.repo}`,
        issueNumber: parsed.number,
        issueUrl: parsed.canonicalUrl,
        acceptanceCriteria: criteriaList,
        rewardUsdc: reward.trim(),
      };
      const response = await postDraft(buildDefinition(input));
      setDraft(response);
      setSubmittedRewardRaw(rewardRaw);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(
          "This wallet is not on the posting allowlist — enrollment is the door's honest gate. Contact the operator to enroll, then retry."
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!wallet) {
    return (
      <p className="font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-muted)]">
        Sign in with your poster wallet to create a bounty.
      </p>
    );
  }

  if (draft && submittedRewardRaw !== null) {
    const draftRecord = asRecord(draft);
    return (
      <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-0.5">
          <span className={LABEL} style={{ letterSpacing: "0.1em" }}>
            Draft created — no funds have moved yet
          </span>
          <span className={cn("break-all text-[12px] text-[var(--avy-ink)]", MONO)}>
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
    <div className="grid gap-4 md:grid-cols-[140px_minmax(0,520px)] md:items-start min-[1080px]:block">
      <PostingStepper
        currentStep={currentStep}
        availableStep={availableStep}
        onStepChange={setMobileStep}
      />
      <div className="flex min-w-0 flex-col gap-4 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]">
      {/* Step 1 — anchor to a real issue */}
      <div className={cn("flex flex-col gap-2", currentStep !== 1 && "max-[1079px]:hidden")}>
        <StepHeading step={1} title="Anchor: your GitHub issue" done={issueVerified} />
        <p className="font-[family-name:var(--font-body)] text-[11.5px] text-[var(--avy-muted)]">
          Every bounty funds work on a real, public GitHub issue. Paste its
          URL — the repository, title, and a work template derive from it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/repo/issues/123"
            spellCheck={false}
            className={cn(FIELD, MONO, "min-w-0 flex-1 text-[12px] sm:min-w-[320px]")}
          />
          <button
            type="button"
            onClick={() => void verifyIssue()}
            disabled={checking || url.trim() === ""}
            className={primaryButton(!checking && url.trim() !== "")}
            style={{ letterSpacing: "0.1em" }}
          >
            {checking ? "Checking…" : "Verify issue"}
          </button>
        </div>
        {url.trim() !== "" && parsed === null && !checking ? (
          <p className="text-[12px] text-[var(--avy-warn)]">
            That is not a GitHub issue URL (expected github.com/owner/repo/issues/number).
          </p>
        ) : null}
        {lookup && !lookup.ok ? (
          <p className="text-[12px] text-[#b22222]">
            {lookup.reason === "not_found"
              ? "Issue not found — check the URL; private repositories can't be bountied (workers need public access)."
              : lookup.reason === "rate_limited"
                ? "GitHub rate-limited the check from this network — wait a minute and retry. The bounty flow only proceeds from a verified issue."
                : "Couldn't reach GitHub to verify — check your connection and retry."}
          </p>
        ) : null}
        {lookup?.ok && lookup.isPullRequest ? (
          <p className="text-[12px] text-[#b22222]">
            That link is a pull request, not an issue — bounties anchor to issues.
          </p>
        ) : null}
        {issueVerified && parsed && lookup?.ok ? (
          <p className="text-[12.5px] text-[var(--avy-ink)]">
            <span className="font-semibold text-[#1e6642]">✓ Verified:</span>{" "}
            <span className={MONO}>
              {parsed.owner}/{parsed.repo}#{parsed.number}
            </span>{" "}
            — “{lookup.title}”
            {lookup.state === "closed" ? (
              <span className="text-[var(--avy-warn)]"> (issue is CLOSED — fund it only if you mean to)</span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* Step 2 — deliverable template */}
      {issueVerified ? (
        <div className={cn("flex flex-col gap-2", currentStep !== 2 && "max-[1079px]:hidden")}>
          <StepHeading step={2} title="Deliverable: what the worker produces" done={kind !== null} />
          <div className="flex flex-wrap gap-2">
            {(
              [
                [
                  "report",
                  "Audit & implementation report",
                  verifierDisclosureForDeliverable("report").summary,
                ],
                [
                  "pr",
                  "Fix with a pull request",
                  verifierDisclosureForDeliverable("pr").summary,
                ],
              ] as Array<[DeliverableKind, string, string]>
            ).map(([value, heading, blurb]) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseKind(value)}
                className={cn(
                  "flex min-h-11 max-w-[320px] flex-1 flex-col gap-1 rounded-[8px] border p-3 text-left",
                  kind === value
                    ? "border-[var(--avy-accent)] bg-[var(--avy-accent-soft)]"
                    : "border-[var(--avy-line)] bg-white/60 hover:border-[var(--avy-accent)]"
                )}
              >
                <span className="font-[family-name:var(--font-display)] text-[12px] font-extrabold text-[var(--avy-ink)]">
                  {heading}
                </span>
                <span className="font-[family-name:var(--font-body)] text-[11.5px] leading-snug text-[var(--avy-muted)]">
                  {blurb}
                </span>
              </button>
            ))}
          </div>
          {kind !== null ? (
            <div className="flex flex-col gap-2 pt-1">
              <div className="rounded-[8px] border border-[var(--avy-line-soft)] bg-[#faf8f1] px-3 py-2">
                <span className={cn(LABEL, "block")} style={{ letterSpacing: "0.1em" }}>
                  Verification gate · {verifierDisclosureForDeliverable(kind).label}
                </span>
                <p className="mt-1 font-[family-name:var(--font-body)] text-[11.5px] leading-snug text-[var(--avy-muted)]">
                  {verifierDisclosureForDeliverable(kind).summary}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
                  Task — seeded from your issue, edit freely
                </label>
                <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} className={FIELD} />
              </div>
              <div className="flex flex-col gap-1">
                <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
                  Acceptance criteria — one per line; you approve against exactly these
                </label>
                <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} className={FIELD} />
              </div>
            </div>
          ) : null}
          {kind !== null ? (
            <button
              type="button"
              disabled={!contentOk}
              onClick={() => setMobileStep(3)}
              className={cn(primaryButton(contentOk), "self-start min-[1080px]:hidden")}
              style={{ letterSpacing: "0.1em" }}
            >
              Continue to reward
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Step 3 — reward with live economics */}
      {issueVerified && kind !== null ? (
        <div className={cn("flex flex-col gap-2", currentStep !== 3 && "max-[1079px]:hidden")}>
          <StepHeading step={3} title="Reward & the honest economics" done={rewardOk} />
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex flex-col gap-1">
              <label className={LABEL} style={{ letterSpacing: "0.1em" }}>
                Reward (USDC{minReward ? `, ≥ ${minReward}` : ""})
              </label>
              <input
                value={reward}
                onChange={(e) => setReward(e.target.value)}
                className={cn(FIELD, "w-[140px]")}
                inputMode="decimal"
                spellCheck={false}
              />
            </div>
            {rewardRaw !== null && rewardOk ? (
              <dl className={cn("grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 text-[12px]", MONO)}>
                <dt className="text-[var(--avy-muted)]">worker receives</dt>
                <dd>{formatRawUsdc(rewardRaw)} USDC — the full reward</dd>
                <dt className="text-[var(--avy-muted)]">you reserve</dt>
                <dd className="font-semibold">
                  {reserveRaw !== null ? `${formatRawUsdc(reserveRaw)} USDC` : "—"}
                  {feeBps !== null ? ` (reward + ${feeBps} bps platform fee on top)` : ""}
                </dd>
                <dt className="text-[var(--avy-muted)]">worker locks to claim</dt>
                <dd>
                  {bondRaw !== null
                    ? `≈ ${formatRawUsdc(bondRaw)} USDC — returned in full on delivery`
                    : "live bond inputs unavailable"}
                </dd>
              </dl>
            ) : reward.trim() !== "" ? (
              <p className="pt-1 text-[12px] text-[var(--avy-warn)]">
                Enter an exact USDC amount{minReward ? ` of at least ${minReward}` : ""} (max 6 decimals).
              </p>
            ) : null}
          </div>
          <p className="font-[family-name:var(--font-body)] text-[11.5px] text-[var(--avy-muted)]">
            Estimates from the live platform config; the exact figures are
            re-read on-chain before you sign anything. Funds stay escrowed
            until the job resolves — there is no self-serve cancel.
          </p>
          <button
            type="button"
            disabled={!rewardOk || !contentOk}
            onClick={() => setMobileStep(4)}
            className={cn(primaryButton(rewardOk && contentOk), "self-start min-[1080px]:hidden")}
            style={{ letterSpacing: "0.1em" }}
          >
            Continue to review
          </button>
        </div>
      ) : null}

      {/* Step 4 — review as the worker sees it */}
      {issueVerified && kind !== null && rewardOk && contentOk && parsed ? (
        <div className={cn("flex flex-col gap-2", currentStep !== 4 && "max-[1079px]:hidden")}>
          <StepHeading step={4} title="Review — exactly what a worker sees" done={false} />
          <div className="flex flex-col gap-1.5 rounded-[8px] border border-[var(--avy-line-soft)] bg-[#faf8f1] p-3">
            <span className="font-[family-name:var(--font-body)] text-[13px] font-semibold text-[var(--avy-ink)]">
              {title || `${parsed.owner}/${parsed.repo}#${parsed.number}`}
            </span>
            <span className={cn("text-[11.5px] text-[var(--avy-muted)]", MONO)}>
              repo {parsed.owner}/{parsed.repo} · reward {reward} USDC · {verifierDisclosureForDeliverable(kind).label} · claim TTL 24h
            </span>
            <p className="font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-ink)]">{task}</p>
            <ul className="list-disc pl-5">
              {criteriaList.map((item) => (
                <li key={item} className="font-[family-name:var(--font-body)] text-[12px] text-[var(--avy-ink)]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting}
              className={primaryButton(!submitting)}
              style={{ letterSpacing: "0.1em" }}
            >
              {submitting ? "Creating draft…" : "Create draft (no funds move)"}
            </button>
            <span className="font-[family-name:var(--font-body)] text-[11.5px] text-[var(--avy-muted)]">
              Next: the platform issues the exact funding transactions and your wallet signs them.
            </span>
          </div>
        </div>
      ) : null}

      {error ? <p className="break-all text-[12.5px] text-[#b22222]">{error}</p> : null}
      </div>
    </div>
  );
}
