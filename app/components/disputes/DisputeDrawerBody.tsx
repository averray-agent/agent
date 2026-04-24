"use client";

import { useEffect, useState } from "react";
import { DrawerSection } from "@/components/shell/DetailDrawer";
import { DisputeStatePill, OriginPill } from "./pills";
import { PartyChip } from "./PartyChip";
import { WindowCountdown } from "./WindowCountdown";
import { EvidenceDiff } from "./EvidenceDiff";
import { StakeHoldPanel } from "./StakeHoldPanel";
import { DecisionPanel } from "./DecisionPanel";
import { DisputeTimeline } from "./DisputeTimeline";
import type { DecisionKind, Dispute, ReleaseDestination } from "./types";

export function DisputeDrawerBody({ dispute }: { dispute: Dispute }) {
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

  // Reset drawer state when navigating between disputes.
  useEffect(() => {
    setDecision(dispute.resolution?.decision ?? null);
    setDestination(dispute.resolution?.destination ?? null);
    setRationale(dispute.resolution?.rationale ?? "");
    setRoleConfirmed(dispute.state === "resolved");
    setCommitted(
      dispute.state === "resolved" ? dispute.resolution?.decision ?? null : null
    );
  }, [dispute.id, dispute.resolution, dispute.state]);

  // If the decision changes, reset the destination to stay consistent
  // (uphold/reject pick different valid destinations; request-more has none).
  const handleDecision = (d: DecisionKind) => {
    setDecision(d);
    if (d === "request-more") setDestination(null);
    else {
      // auto-pick a default that matches the decision.
      if (d === "uphold" && destination !== "slash-to-treasury" && destination !== "pay-verifier") {
        setDestination("slash-to-treasury");
      }
      if (d === "reject" && destination !== "return-to-depositor") {
        setDestination("return-to-depositor");
      }
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
        </div>
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
            onCommit={() => setCommitted(decision)}
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

function ResolvedCard({ dispute }: { dispute: Dispute }) {
  if (!dispute.resolution) return null;
  const { decision, destination, rationale, at, signer } = dispute.resolution;
  const decisionLabel =
    decision === "uphold"
      ? "Upheld"
      : decision === "reject"
        ? "Rejected"
        : "Requested more evidence";
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
