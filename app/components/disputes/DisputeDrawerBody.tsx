"use client";

import { useEffect, useState } from "react";
import { mutate } from "swr";
import { DrawerSection } from "@/components/shell/DetailDrawer";
import { ExplorerLink } from "@/components/common/ExplorerLink";
import { OutcomeRationaleInline } from "@/components/common/OutcomeRationaleInline";
import { decisionToVerdict } from "@/lib/api/dispute-adapters";
import { releaseAmountForDecision } from "@/lib/api/dispute-verdicts";
import { swrFetcher } from "@/lib/api/client";
import { DisputeStatePill, OriginPill } from "./pills";
import { PartyChip } from "./PartyChip";
import { WindowCountdown } from "./WindowCountdown";
import { EvidenceDiff } from "./EvidenceDiff";
import { StakeHoldPanel } from "./StakeHoldPanel";
import { DecisionPanel } from "./DecisionPanel";
import { DisputeTimeline } from "./DisputeTimeline";
import type { DecisionKind, Dispute, ReleaseDestination } from "./types";

export function DisputeDrawerBody({
  dispute,
  live = false,
}: {
  dispute: Dispute;
  live?: boolean;
}) {
  const resolved = dispute.state === "resolved";
  const [decision, setDecision] = useState<DecisionKind | null>(
    dispute.resolution?.decision ?? null
  );
  const [destination, setDestination] = useState<ReleaseDestination | null>(
    dispute.resolution?.destination ?? null
  );
  const [rationale, setRationale] = useState(dispute.resolution?.rationale ?? "");
  const [roleConfirmed, setRoleConfirmed] = useState(resolved);
  const [committed, setCommitted] = useState<DecisionKind | null>(
    resolved ? dispute.resolution?.decision ?? null : null
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset drawer state when navigating between disputes.
  useEffect(() => {
    setDecision(dispute.resolution?.decision ?? null);
    setDestination(dispute.resolution?.destination ?? null);
    setRationale(dispute.resolution?.rationale ?? "");
    setRoleConfirmed(dispute.state === "resolved");
    setCommitted(
      dispute.state === "resolved" ? dispute.resolution?.decision ?? null : null
    );
    setSubmitting(false);
    setSubmitError(null);
  }, [dispute.id, dispute.resolution, dispute.state]);

  // If the decision changes, reset the destination to stay consistent
  // with the backend verdict settlement path.
  const handleDecision = (d: DecisionKind) => {
    setDecision(d);
    if (d === "uphold" && destination !== "slash-to-treasury" && destination !== "pay-verifier") {
      setDestination("slash-to-treasury");
    }
    if ((d === "reject" || d === "split" || d === "timeout") && destination !== "return-to-depositor") {
      setDestination("return-to-depositor");
    }
  };

  const handleCommit = async () => {
    if (!decision) return;
    if (!live) {
      setCommitted(decision);
      return;
    }

    const detailKey = `/disputes/${encodeURIComponent(dispute.id)}`;
    let verdictCommitted = false;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await swrFetcher([
        `${detailKey}/verdict`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            verdict: decisionToVerdict(decision),
            rationale: rationale.trim(),
          }),
        },
      ]);
      verdictCommitted = true;

      if (destination) {
        await swrFetcher([
          `${detailKey}/release`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: destination,
              destination,
              amount: releaseAmountForDecision({
                decision,
                remainingPayout: dispute.remainingPayout,
                stakeFrozen: dispute.stakeFrozen,
              }),
            }),
          },
        ]);
      }

      setCommitted(decision);
      mutate("/disputes");
      mutate(detailKey);
    } catch {
      if (verdictCommitted) {
        setCommitted(decision);
        mutate("/disputes");
        mutate(detailKey);
        setSubmitError("Verdict signed. Stake release still needs admin approval.");
      } else {
        setSubmitError("Could not sign this verdict. Check your role and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerSection title="The disagreement">
        <div className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <OriginPill origin={dispute.origin} />
            <DisputeStatePill state={dispute.state} />
            <WindowCountdown
              total={dispute.windowSeconds}
              elapsed={dispute.windowElapsed}
              frozen={resolved}
            />
          </div>
          <p
            className="mt-2.5 text-[14px] leading-[1.55] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            {dispute.summary}
          </p>
          <div className="mt-3 flex flex-wrap gap-5">
            <PartyBlock label="Opener" party={dispute.opener} />
            <PartyBlock label="Respondent" party={dispute.respondent} />
            <PartyBlock label="Reviewer" party={dispute.reviewer} />
          </div>
          <div
            className="mt-3 flex flex-wrap gap-4 border-t border-[var(--avy-line-soft)] pt-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            <span>
              Run · <span className="text-[var(--avy-ink)]">{dispute.runRef}</span>
            </span>
            <span>
              Opening receipt ·{" "}
              <span className="text-[var(--avy-accent)]">{dispute.openingReceipt}</span>
            </span>
            <span>
              Opened · <span className="text-[var(--avy-ink)]">{dispute.openedAt}</span>
            </span>
          </div>
          {dispute.outcomeRationale ? (
            <OutcomeRationaleInline rationale={dispute.outcomeRationale} />
          ) : null}
        </div>
      </DrawerSection>

      <DrawerSection title="Arbitration">
        <ArbitrationCard dispute={dispute} />
      </DrawerSection>

      <DrawerSection title="Evidence">
        <EvidenceDiff
          workerPayload={dispute.workerPayload}
          expectedPayload={dispute.expectedPayload}
          rows={dispute.evidence}
        />
      </DrawerSection>

      <DrawerSection title="Stake hold">
        <StakeHoldPanel
          total={dispute.stakeFrozen}
          breakdown={dispute.stakeBreakdown}
          destination={destination}
          onDestinationChange={setDestination}
          decision={decision}
          disabled={!!committed || resolved}
        />
      </DrawerSection>

      <DrawerSection title="Escalation">
        {dispute.escalatedBy ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[color:rgba(167,97,34,0.32)] bg-[var(--avy-warn-soft)] px-3.5 py-3">
            <div>
              <div
                className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-warn)]"
                style={{ letterSpacing: "0.12em" }}
              >
                Currently escalated
              </div>
              <p
                className="mt-0.5 text-[13px] leading-snug text-[var(--avy-ink)]"
                style={{ letterSpacing: 0 }}
              >
                Escalated by{" "}
                <b className="font-semibold">{dispute.escalatedBy.handle}</b> at{" "}
                <span className="font-[family-name:var(--font-mono)]">
                  {dispute.escalatedAt}
                </span>
                . Verifier-2 reviewing in parallel.
              </p>
            </div>
            <PartyChip party={dispute.escalatedBy} layout="stacked" />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 py-3">
            <div>
              <div
                className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
                style={{ letterSpacing: "0.12em" }}
              >
                Current reviewer
              </div>
              <div
                className="mt-1 font-[family-name:var(--font-display)] text-[13px] font-bold text-[var(--avy-ink)]"
              >
                {dispute.reviewer.handle}
              </div>
              <span
                className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                {dispute.reviewer.address}
              </span>
            </div>
            <button
              type="button"
              disabled={resolved || !!committed}
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[color:rgba(167,97,34,0.35)] bg-[var(--avy-warn-soft)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-warn)] transition-transform hover:-translate-y-px hover:border-[color:rgba(167,97,34,0.55)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
              style={{ letterSpacing: "0.04em" }}
            >
              Escalate to verifier-2
            </button>
          </div>
        )}
      </DrawerSection>

      {resolved ? (
        <DrawerSection title="Verdict">
          <ResolvedCard dispute={dispute} />
        </DrawerSection>
      ) : committed ? (
        <DrawerSection title="Verdict queued">
          <div className="rounded-[10px] border border-[color:rgba(30,102,66,0.35)] bg-[var(--avy-accent-soft)] px-4 py-3.5">
            <div
              className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
              style={{ letterSpacing: "0.12em" }}
            >
              ✓ Signed · awaiting receipt
            </div>
            <p
              className="mt-1 text-[13px] leading-snug text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              Verdict <b>{committed}</b> committed. The receipt will appear in the
              Activity feed after the next block finalizes (~6s).
            </p>
          </div>
        </DrawerSection>
      ) : (
        <DrawerSection title="Decision">
          <DecisionPanel
            decision={decision}
            onDecision={handleDecision}
            rationale={rationale}
            onRationaleChange={setRationale}
            roleConfirmed={roleConfirmed}
            onRoleToggle={() => setRoleConfirmed((v) => !v)}
            destination={destination}
            onCommit={handleCommit}
            busy={submitting}
            error={submitError}
          />
        </DrawerSection>
      )}

      <DrawerSection title="Timeline">
        <DisputeTimeline events={dispute.timeline} />
      </DrawerSection>
    </>
  );
}

function PartyBlock({
  label,
  party,
}: {
  label: string;
  party: Dispute["opener"];
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </span>
      <PartyChip party={party} layout="stacked" />
    </div>
  );
}

function ArbitrationCard({ dispute }: { dispute: Dispute }) {
  const { arbitration } = dispute;
  const slaStatus = arbitration.sla.expired
    ? "Expired"
    : typeof arbitration.sla.secondsRemaining === "number"
      ? `${formatDuration(arbitration.sla.secondsRemaining)} left`
      : "Window active";
  const releaseReady = arbitration.release.ready;

  return (
    <div className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
        <ArbitrationDatum
          label="SLA"
          value={slaStatus}
          note={
            arbitration.sla.windowEndsAt
              ? `Ends ${formatIso(arbitration.sla.windowEndsAt)}`
              : `${formatDuration(arbitration.sla.seconds)} window`
          }
          tone={arbitration.sla.expired ? "warn" : "accent"}
        />
        <ArbitrationDatum
          label="Release"
          value={releaseReady ? "Ready after verdict" : releaseReasonLabel(arbitration.release.reason)}
          note={arbitration.release.requiresVerdict ? "Requires verdict receipt first" : "Admin receipt only"}
          tone={releaseReady ? "accent" : "neutral"}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {arbitration.allowedVerdicts.map((verdict) => (
          <span
            key={verdict}
            className="rounded-full border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.03)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            {verdictLabel(verdict)}
          </span>
        ))}
      </div>

      <div
        className="mt-3 grid gap-1.5 border-t border-[var(--avy-line-soft)] pt-3 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>
          Reasoning ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            {arbitration.reasoning.hashAlgorithm} {arbitration.reasoning.hashField}
          </b>{" "}
          → <b className="font-semibold text-[var(--avy-ink)]">{arbitration.reasoning.uriField}</b>
        </span>
        <span>
          Authority ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            {authorityLabel(arbitration.authority.verdict)}
          </b>{" "}
          verdict ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            {authorityLabel(arbitration.authority.release)}
          </b>{" "}
          release
        </span>
      </div>
    </div>
  );
}

function ArbitrationDatum({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: "accent" | "neutral" | "warn";
}) {
  const toneClass = {
    accent: "text-[var(--avy-accent)]",
    neutral: "text-[var(--avy-ink)]",
    warn: "text-[var(--avy-warn)]",
  }[tone];
  return (
    <div className="rounded-[8px] border border-[var(--avy-line-soft)] bg-[color:rgba(17,19,21,0.025)] px-3 py-2.5">
      <div
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {label}
      </div>
      <div
        className={`mt-1 font-[family-name:var(--font-display)] text-[13px] font-bold ${toneClass}`}
        style={{ letterSpacing: 0 }}
      >
        {value}
      </div>
      <div
        className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {note}
      </div>
    </div>
  );
}

const CHAIN_STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  submitted: "Submitted",
  local_only: "Local only",
  settled_by_verdict: "Settled by verdict",
};

const CHAIN_STATUS_DOT_CLASS: Record<string, string> = {
  confirmed: "bg-[var(--avy-accent)]",
  settled_by_verdict: "bg-[var(--avy-accent)]",
  submitted: "bg-[#254e9a]",
  local_only: "bg-[var(--avy-warn)]",
};

function humaniseChainStatus(status: string): string {
  return CHAIN_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function chainStatusDotClass(status: string): string {
  return CHAIN_STATUS_DOT_CLASS[status] ?? "bg-[var(--avy-muted)]";
}

function verdictLabel(value: string): string {
  const normalized = value.replace(/_/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function authorityLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function releaseReasonLabel(value: string): string {
  const labels: Record<string, string> = {
    awaiting_arbitrator_verdict: "Awaiting verdict",
    verdict_recorded: "Verdict recorded",
    release_already_recorded: "Release recorded",
  };
  return labels[value] ?? authorityLabel(value);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `${minutes}m`;
}

function formatIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const date = new Date(parsed);
  const month = date.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const day = date.toLocaleString("en", { day: "numeric", timeZone: "UTC" });
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day} · ${hh}:${mm} UTC`;
}

function shortHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function isLinkableUri(value: string): boolean {
  return /^(?:https?|ipfs):\/\//u.test(value);
}

function formatPayoutAmount(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 4,
  });
}

function ResolvedCard({ dispute }: { dispute: Dispute }) {
  if (!dispute.resolution) return null;
  const {
    decision,
    destination,
    rationale,
    at,
    signer,
    reasonCode,
    workerPayout,
    txHash,
    chainStatus,
    metadataURI,
    reasoningHash,
  } = dispute.resolution;
  const hasOnchainMeta =
    Boolean(reasonCode) ||
    typeof workerPayout === "number" ||
    Boolean(chainStatus) ||
    Boolean(txHash) ||
    Boolean(metadataURI) ||
    Boolean(reasoningHash);
  const decisionLabel =
    decision === "uphold"
      ? "Upheld"
      : decision === "reject"
        ? "Rejected"
        : decision === "timeout"
          ? "Timeout"
          : "Split payout";
  const destinationLabel =
    destination === "return-to-depositor"
      ? "Returned to depositor"
      : destination === "pay-verifier"
        ? "Paid to verifier"
        : "Slashed to treasury";
  const isBad = decision === "uphold";

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-[color:rgba(30,102,66,0.28)] bg-[color:rgba(30,102,66,0.05)] px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span
          className={`font-[family-name:var(--font-display)] text-[13px] font-extrabold uppercase ${
            isBad ? "text-[#8c2a17]" : "text-[var(--avy-accent)]"
          }`}
          style={{ letterSpacing: "0.08em" }}
        >
          {decisionLabel}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {at}
        </span>
      </div>
      <div
        className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        Stake → {destinationLabel}
      </div>
      {hasOnchainMeta ? (
        <div
          className="grid gap-1 rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {reasonCode ? (
            <span>
              Reason ·{" "}
              <b className="font-semibold text-[var(--avy-ink)]">{reasonCode}</b>
            </span>
          ) : null}
          {typeof workerPayout === "number" ? (
            <span>
              Worker payout ·{" "}
              <b className="font-semibold text-[var(--avy-ink)]">
                {formatPayoutAmount(workerPayout)} DOT
              </b>
            </span>
          ) : null}
          {chainStatus ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${chainStatusDotClass(chainStatus)}`}
                aria-hidden="true"
              />
              <span>
                Chain ·{" "}
                <b className="font-semibold text-[var(--avy-ink)]">
                  {humaniseChainStatus(chainStatus)}
                </b>
              </span>
            </span>
          ) : null}
          {txHash ? (
            <span>
              Tx ·{" "}
              <ExplorerLink kind="tx" value={txHash} label={shortHash(txHash)} />
            </span>
          ) : null}
          {metadataURI ? (
            <span className="break-all">
              Reasoning URI ·{" "}
              {isLinkableUri(metadataURI) ? (
                <a
                  href={metadataURI}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-semibold text-[var(--avy-ink)] hover:text-[var(--avy-accent)] hover:underline"
                >
                  {metadataURI} ↗
                </a>
              ) : (
                <b className="font-semibold text-[var(--avy-ink)]">{metadataURI}</b>
              )}
            </span>
          ) : null}
          {reasoningHash ? (
            <span>
              Reasoning hash ·{" "}
              <b
                className="font-semibold text-[var(--avy-ink)]"
                title={reasoningHash}
              >
                {shortHash(reasoningHash)}
              </b>
            </span>
          ) : null}
        </div>
      ) : null}
      <p
        className="m-0 text-[13px] leading-snug text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        {rationale}
      </p>
      <div className="flex items-center gap-2 border-t border-[var(--avy-line-soft)] pt-2">
        <PartyChip party={signer} />
      </div>
    </div>
  );
}
