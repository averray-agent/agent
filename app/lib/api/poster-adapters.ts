import { CLAIM_STATE_LABEL, CLAIM_STATE_TONE, type ClaimEffectiveState } from "@/lib/api/claim-status";

/** Tones the pill palette already covers (mirrors claim-status). */
export type StateTone = "ok" | "neutral" | "warn" | "muted" | "bad";

export interface PosterJobRow {
  id: string;
  title: string;
  /** Raw effective/claim state as the API reports it (lowercased). */
  state: string;
  stateLabel: string;
  stateTone: StateTone;
  rewardLabel: string | null;
  /** Live policy estimate — per-wallet truth stays the preflight endpoint. */
  bondLabel: string | null;
  bondPreflightPath: string | null;
  fundedTxHash: string | null;
  fundedAt: string | null;
  claimedBy: string | null;
  posterWallet: string | null;
}

export interface PosterJobsView {
  /** Jobs whose recorded on-chain poster is the signed-in wallet. */
  mine: PosterJobRow[];
  /** All external rows the catalog currently projects (any poster). */
  externalTotal: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Render a raw 6-decimal USDC amount ("150000" → "0.15"). */
export function formatUsdcRaw(raw: unknown): string | null {
  const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  if (!value || !/^\d+$/u.test(value)) return null;
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function stateChip(raw: unknown): { label: string; tone: StateTone } {
  const state = text(raw)?.toLowerCase() ?? "unknown";
  if (state in CLAIM_STATE_LABEL) {
    const key = state as ClaimEffectiveState;
    return { label: CLAIM_STATE_LABEL[key], tone: CLAIM_STATE_TONE[key] };
  }
  // States the claim map doesn't cover (e.g. plain "open") render as
  // themselves — never invent a friendlier label than the API gives.
  return { label: state.charAt(0).toUpperCase() + state.slice(1), tone: "muted" };
}

function toRow(rawJob: unknown): PosterJobRow | null {
  const job = asRecord(rawJob);
  const id = text(job.id);
  if (!id) return null;
  const reward = asRecord(job.reward);
  const bond = asRecord(job.claimBond);
  const source = asRecord(job.sourceDetails);
  const poster = asRecord(job.poster);
  const chip = stateChip(job.effectiveState ?? job.state);
  const rewardAmount =
    typeof reward.amount === "number" || typeof reward.amount === "string"
      ? String(reward.amount)
      : null;
  const bondTotal = bond.available === true ? formatUsdcRaw(bond.totalRaw) : null;
  return {
    id,
    title: text(job.title) ?? id,
    state: (text(job.effectiveState) ?? text(job.state) ?? "unknown").toLowerCase(),
    stateLabel: chip.label,
    stateTone: chip.tone,
    rewardLabel: rewardAmount ? `${rewardAmount} ${text(reward.asset) ?? ""}`.trim() : null,
    bondLabel: bondTotal ? `${bondTotal} ${text(bond.asset) ?? "USDC"}` : null,
    bondPreflightPath: text(bond.perWalletTruth),
    fundedTxHash: text(source.txHash) ?? text(poster.txHash),
    fundedAt: text(source.fundedAt) ?? text(poster.fundedAt),
    claimedBy: text(job.claimedBy),
    posterWallet: (text(source.wallet) ?? text(poster.wallet))?.toLowerCase() ?? null,
  };
}

/**
 * Build the poster lens view from the public jobs catalog. Rows are the
 * catalog's external projection; "mine" filters by the recorded on-chain
 * poster wallet — the API is the truth, the wallet only selects.
 */
export function buildPosterJobsView(payload: unknown, wallet: string | null): PosterJobsView {
  const jobs = asRecord(payload).jobs;
  const rows = (Array.isArray(jobs) ? jobs : [])
    .map(toRow)
    .filter((row): row is PosterJobRow => row !== null);
  const me = wallet?.toLowerCase() ?? null;
  return {
    mine: me ? rows.filter((row) => row.posterWallet === me) : [],
    externalTotal: rows.length,
  };
}

/**
 * Worker-bond estimate from the live /poster/onboarding claimBond facts
 * (stake bps + fee bps with a raw minimum). Display-only — the per-wallet
 * truth stays the preflight endpoint; returns null when live inputs are
 * missing rather than guessing.
 */
export function estimateWorkerBondRaw(rewardRaw: bigint, claimBond: unknown): bigint | null {
  const bond = asRecord(claimBond);
  if (bond.available !== true) return null;
  const stakeBps = typeof bond.stakeBps === "number" ? BigInt(bond.stakeBps) : null;
  const feeBps = typeof bond.feeBps === "number" ? BigInt(bond.feeBps) : null;
  const minFeeRaw =
    typeof bond.minFeeRaw === "string" && /^\d+$/u.test(bond.minFeeRaw)
      ? BigInt(bond.minFeeRaw)
      : 0n;
  if (stakeBps === null || feeBps === null) return null;
  const stake = (rewardRaw * stakeBps) / 10_000n;
  const fee = (rewardRaw * feeBps) / 10_000n;
  return stake + (fee > minFeeRaw ? fee : minFeeRaw);
}

export interface DraftView {
  status: string;
  statusTone: StateTone;
  fields: Array<{ label: string; value: string; mono: boolean }>;
}

const DRAFT_STATUS_TONE: Record<string, StateTone> = {
  quoted: "warn",
  awaiting_funding: "warn",
  live: "ok",
  expired: "muted",
};

/** Present a draft response without inventing fields the API didn't return. */
export function buildDraftView(payload: unknown): DraftView {
  const draft = asRecord(payload);
  const status = text(draft.status) ?? "unknown";
  const tone: StateTone = status.startsWith("mismatch")
    ? "bad"
    : (DRAFT_STATUS_TONE[status] ?? "muted");
  const fields: DraftView["fields"] = [];
  const push = (label: string, value: unknown, mono = true) => {
    const rendered = text(value);
    if (rendered) fields.push({ label, value: rendered, mono });
  };
  push("Draft ID", draft.draftId);
  push("Job ID", draft.jobId);
  push("Spec hash", draft.specHash);
  push("Expires", draft.expiresAt, false);
  push("Funding tx", draft.txHash);
  return { status, statusTone: tone, fields };
}
