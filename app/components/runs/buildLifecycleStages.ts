/**
 * Live session-lifecycle stages for the runs panel.
 *
 * Replaces the four FIXTURE_LIFECYCLE_* arrays at the page level. A row
 * loaded from `/jobs[]` or `/admin/jobs[]` carries `claim.state`,
 * `claim.claimedAt`, and `claim.claimExpiresAt` once the run has a
 * session in flight; this builder turns those into the 5-stage rail
 * the LifecycleRail component already knows how to render.
 *
 * Source-aware on the third stage label (PR submitted / Proposal
 * submitted / Audit submitted) so the copy matches the loaded row's
 * provenance — same split as the FIXTURE_LIFECYCLE_* variants.
 */

import type { LifecycleStage, StageTone } from "./LifecycleRail";
import type { JobSource } from "./types";
import type { ClaimEffectiveState, ClaimSummary } from "@/lib/api/claim-status";
import type { TimelineEntry } from "@/lib/api/job-timeline";

interface BuildArgs {
  /** Live claim state from the loaded row. Optional so we can still
   *  render a sensible 5-stage skeleton when the row is fixture-only. */
  claim?: ClaimSummary;
  source?: JobSource;
  /** Falls back to `Date.now()` so SSR + first paint produce a stable
   *  rail; callers in client components can pass a memoised "now" when
   *  they want to drive the deadline countdown. */
  now?: Date;
  /** Optional v2 timeline entries (PR #158). When supplied the
   *  builder maps `severity: "warn" | "error"` events back to the
   *  rail stage they reference and tints that stage to flag the
   *  issue without changing whether it's "done". */
  timeline?: TimelineEntry[];
}

const SUBMITTED_LABEL: Record<string, string> = {
  github_issue: "PR submitted",
  wikipedia_article: "Proposal submitted",
  osv_advisory: "PR submitted",
  open_data_dataset: "Audit submitted",
  openapi_spec: "Audit submitted",
  standards_spec: "Audit submitted",
  native: "Submitted",
};

export function buildLifecycleStages({
  claim,
  source,
  now = new Date(),
  timeline,
}: BuildArgs): LifecycleStage[] {
  const submittedLabel = SUBMITTED_LABEL[source?.type ?? "native"] ?? "Submitted";
  const state: ClaimEffectiveState = claim?.state ?? "claimable";
  const tones = toneOverlayFromTimeline(timeline);

  // The first stage is always "Ready" (the catalog row exists). We
  // only mark the rest based on what the live state tells us.
  const stages: Array<Omit<LifecycleStage, "index">> = [
    {
      label: "Ready",
      meta: "—",
      state: "done",
      ...(tones.ready ? { tone: tones.ready } : {}),
    },
    {
      label: "Claimed",
      meta: claim?.claimedAt
        ? `${formatTime(claim.claimedAt)}${
            claim.claimedBy ? ` · by ${shortWallet(claim.claimedBy)}` : ""
          }`
        : "—",
      state: stageStateFor(state, "claimed"),
      ...(tones.claimed ? { tone: tones.claimed } : {}),
    },
    {
      label: submittedLabel,
      meta: state === "submitted" || isPostSubmission(state)
        ? "evidence sent"
        : claim?.claimExpiresAt && state === "claimed"
          ? deadlineCountdown(claim.claimExpiresAt, now)
          : "—",
      state: stageStateFor(state, "submitted"),
      ...(tones.submitted ? { tone: tones.submitted } : {}),
    },
    {
      label: "Verified",
      meta: state === "submitted" ? "awaiting verifier" : "—",
      state: stageStateFor(state, "verified"),
      ...(tones.verified ? { tone: tones.verified } : {}),
    },
    {
      label: "Paid",
      meta: "—",
      state: stageStateFor(state, "paid"),
      ...(tones.paid ? { tone: tones.paid } : {}),
    },
  ];
  return stages.map((stage, idx) => ({ ...stage, index: idx + 1 }));
}

/**
 * Map the v2 timeline entries to per-stage tone overlays. Returns the
 * highest severity any event with a stage-relevant `phase` carries, so
 * a single warn event tints the stage even when surrounded by info
 * rows.
 *
 * The mapping is deliberately conservative — we only color a stage
 * when the backend's `severity` field plus the entry `phase`/`type`
 * pair clearly identifies which stage the issue belongs to. Anything
 * else stays untinted.
 */
function toneOverlayFromTimeline(
  timeline: TimelineEntry[] | undefined
): Partial<Record<RailStage, StageTone>> {
  if (!timeline || timeline.length === 0) return {};
  const out: Partial<Record<RailStage, StageTone>> = {};
  for (const entry of timeline) {
    if (entry.severity !== "warn" && entry.severity !== "error") continue;
    const stage = stageForEntry(entry);
    if (!stage) continue;
    out[stage] = mergeTone(out[stage], entry.severity);
  }
  return out;
}

type RailStage = "ready" | "claimed" | "submitted" | "verified" | "paid";

function stageForEntry(entry: TimelineEntry): RailStage | undefined {
  const phase = String(entry.phase ?? "").toLowerCase();
  const type = String(entry.type ?? "").toLowerCase();
  if (type === "verification" || phase === "verification") return "verified";
  if (type === "session_transition" || type === "session_snapshot") {
    // Map session phase to the rail stage. The backend phases are
    // "claim", "work" (post-claim, pre-submit), "submit", "verify",
    // "settle"; treat anything past submit as the verified stage.
    if (phase === "settle") return "paid";
    if (phase === "verify") return "verified";
    if (phase === "submit") return "submitted";
    if (phase === "work" || phase === "claim") return "claimed";
  }
  if (type === "child_job" || type === "derivative_job") {
    // Lineage events live "after the claim" — surface as a flag on
    // the Claimed stage rather than tinting the whole rail.
    return "claimed";
  }
  return undefined;
}

function mergeTone(
  current: StageTone | undefined,
  incoming: "warn" | "error"
): StageTone {
  if (current === "error") return "error";
  if (incoming === "error") return "error";
  return "warn";
}

/**
 * For each rail stage, derive its visual state (done / current /
 * pending) from the live claim `effectiveState`.
 *
 * The mapping has to be lossy — there's no first-class "verified" or
 * "paid" claim state today (verification + settlement are downstream
 * of `submitted`). We treat `submitted` as "Submitted is done, Verified
 * is current"; once a verified/settled state surfaces we can extend
 * this without churning callers.
 */
function stageStateFor(
  state: ClaimEffectiveState,
  stage: "claimed" | "submitted" | "verified" | "paid"
): LifecycleStage["state"] {
  if (state === "exhausted" || state === "expired") {
    // The row is out of attempts; nothing past Ready is current. Mark
    // everything else as pending so the rail doesn't pretend a future
    // claim is in progress.
    return "pending";
  }
  if (state === "claimable") {
    return "pending";
  }
  if (state === "claimed") {
    if (stage === "claimed") return "current";
    return "pending";
  }
  if (state === "submitted") {
    if (stage === "claimed") return "done";
    if (stage === "submitted") return "done";
    if (stage === "verified") return "current";
    return "pending";
  }
  return "pending";
}

function isPostSubmission(state: ClaimEffectiveState): boolean {
  return state === "submitted";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // HH:MM:SS UTC — matches the visual rhythm the fixture rail used.
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function shortWallet(wallet: string): string {
  const trimmed = wallet.trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function deadlineCountdown(iso: string, now: Date): string {
  const deadline = Date.parse(iso);
  if (!Number.isFinite(deadline)) return "—";
  const diff = deadline - now.getTime();
  if (diff <= 0) return "deadline passed";
  const minutes = Math.floor(diff / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `closes in ${hours}h ${mins}m`;
  }
  return `closes in ${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Same idea as `deadlineCountdown` but exposed for the page-level
 * "Window closes in 21m 46s" header. Returns the raw ISO when no
 * deadline is known so callers can drop the line entirely.
 */
export function formatDeadline(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  return deadlineCountdown(iso, now);
}

/**
 * Friendly "by 0x30bc…ee05" / "by you" label for the CLAIMED stage.
 * Pass the connected wallet (lowercase) when known so we render
 * "(you)" instead of the bare address.
 */
export function describeClaimer(
  claimedBy: string | undefined,
  connectedWallet: string | undefined
): string {
  if (!claimedBy) return "";
  if (
    connectedWallet &&
    claimedBy.toLowerCase() === connectedWallet.toLowerCase()
  ) {
    return "by you";
  }
  return `by ${shortWallet(claimedBy)}`;
}
