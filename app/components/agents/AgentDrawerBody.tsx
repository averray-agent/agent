"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import { BadgeChip } from "./BadgeStrip";
import { TierChip } from "./TierChip";
import {
  BADGES,
  tierFor,
  nextThreshold,
  type AgentActiveSession,
  type AgentDelegatedLineage,
  type AgentRecord,
  type AgentSubcontractedLineage,
  type AgentTier,
} from "./types";

const TIERS: { id: AgentTier; lo: number; hi: number }[] = [
  { id: "T1", lo: 0, hi: 300 },
  { id: "T2", lo: 300, hi: 800 },
  { id: "T3", lo: 800, hi: 1000 },
];

export function AgentDrawerBody({ agent }: { agent: AgentRecord }) {
  const lockPct = agent.stake.deposited > 0 ? agent.stake.locked / agent.stake.deposited : 0;
  const curTier = tierFor(agent.score);
  const next = nextThreshold(agent.score);
  const profileUrl = `https://averray.com/agents/${agent.walletFull}`;
  const showSparkline = agent.sparkline.some((v) => v > 0);
  // Badge section copy depends on whether any badge represents a
  // verified-receipt outcome. Capability markers granted on registration
  // (e.g. "Coding L1" assigned to every fresh wallet) shouldn't be
  // labelled "earned" — that conflates "the agent did something" with
  // "the agent has the right to do something".
  const badgeSectionTitle = agent.hasVerifiedBadges
    ? `Badges earned · ${agent.badges.length}`
    : `Capabilities · ${agent.badges.length}`;
  const badgeNote = agent.hasVerifiedBadges
    ? null
    : "starter capability — not from a verified receipt";

  return (
    <>
      <Section title="Public identity">
        <PublicIdentityCard wallet={agent.walletFull} profileUrl={profileUrl} />
      </Section>

      {agent.activeSession ? (
        <Section title="Active session">
          <ActiveSessionCard session={agent.activeSession} />
        </Section>
      ) : null}

      <Section title="Reputation · 30d">
        <div className="grid gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-4 py-3.5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="font-[family-name:var(--font-display)] text-[2.1rem] font-bold leading-none tabular-nums">
                {agent.score}
                <span className="ml-1.5 align-super">
                  <TierChip tier={agent.tier} />
                </span>
              </div>
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
                {next
                  ? `+${next - agent.score} to ${tierFor(next)}`
                  : "top tier — no further ladder"}
              </div>
            </div>
            {showSparkline ? (
              <Sparkline points={agent.sparkline} width={160} height={34} />
            ) : (
              <span
                aria-hidden="true"
                className="block h-[2px] w-[160px] rounded-full bg-[color:rgba(17,19,21,0.08)]"
              />
            )}
          </div>
          <div className="grid gap-1.5">
            {TIERS.map((t) => {
              const isCur = t.id === curTier;
              const pct =
                Math.max(0, Math.min(1, (agent.score - t.lo) / (t.hi - t.lo))) * 100;
              const hiLabel = t.hi === 1000 ? "∞" : t.hi;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "grid items-center gap-3 font-[family-name:var(--font-mono)] text-[11.5px]",
                    isCur
                      ? "font-semibold text-[var(--avy-ink)]"
                      : "text-[var(--avy-muted)]"
                  )}
                  style={{ gridTemplateColumns: "2.5rem 1fr auto", letterSpacing: 0 }}
                >
                  <span>{t.id}</span>
                  <div className="h-1.5 overflow-hidden rounded-[3px] bg-[color:rgba(17,19,21,0.08)]">
                    <span
                      className={cn(
                        "block h-full",
                        isCur
                          ? "bg-[var(--avy-accent)]"
                          : "bg-[color:rgba(30,102,66,0.35)]"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span>
                    {t.lo}–{hiLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title={badgeSectionTitle}>
        {badgeNote ? (
          <p
            className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            {badgeNote}
          </p>
        ) : null}
        {agent.badges.length === 0 ? (
          <div
            className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            No capabilities recorded yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {agent.badges.map((b) => {
              const def = BADGES[b];
              const issued = agent.badgeDates[b];
              return (
                <div
                  key={b}
                  className="grid items-center gap-2.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2.5"
                  style={{ gridTemplateColumns: "28px 1fr" }}
                >
                  <BadgeChip badgeId={b} size="md" />
                  <div>
                    <div className="font-[family-name:var(--font-display)] text-[12.5px] font-bold text-[var(--avy-ink)]">
                      {def?.name}
                    </div>
                    <div
                      className="mt-px font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {agent.hasVerifiedBadges
                        ? issued
                          ? `issued ${issued}`
                          : "issued —"
                        : "starter capability"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Recent runs · last 8">
        <RecentRunsBlock agent={agent} />
      </Section>

      <Section title="Sub-contracting">
        <SubcontractingBlock agent={agent} />
      </Section>

      <Section title="Stake">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StakeCell label="Deposited" value={`${agent.stake.deposited} DOT`} />
          <StakeCell
            label="Locked"
            value={`${agent.stake.locked} DOT`}
            tone={lockPct > 0.8 ? "warn" : undefined}
          />
          <StakeCell label="Available" value={`${agent.stake.available} DOT`} />
          <StakeCell
            label="Slashed 30d"
            value={`${agent.stake.slashed30} DOT`}
            tone={agent.stake.slashed30 > 0 ? "bad" : undefined}
          />
        </div>
      </Section>

      <Section title="Slash events">
        {agent.slashes.length === 0 ? (
          <div
            className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            No slashes on record — clean history since first seen.
          </div>
        ) : (
          <div className="grid gap-2">
            {agent.slashes.map((s, i) => (
              <div
                key={i}
                className="grid items-start gap-2.5"
                style={{ gridTemplateColumns: "10px 1fr auto" }}
              >
                <span className="mt-1.5 h-2 w-2 rounded-full bg-[#8a2a2a]" />
                <div>
                  <div className="text-[13px] text-[var(--avy-ink)]">
                    <b className="font-semibold">{s.amount}</b> — {s.reason}
                  </div>
                  <span
                    className="mt-px block font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                    style={{ letterSpacing: 0 }}
                  >
                    receipt {s.ref}
                  </span>
                </div>
                <span
                  className="whitespace-nowrap font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  {s.when}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

/**
 * Public-identity header. Wallet + profile URL never overflow horizontally —
 * we render the long string in a wrapping container, then offer
 * middle-truncated buttons for `Open` and `Copy` so the full address is
 * always one click away without ever creating a horizontal scrollbar.
 */
function PublicIdentityCard({
  wallet,
  profileUrl,
}: {
  wallet: string;
  profileUrl: string;
}) {
  const [copied, setCopied] = useState<"wallet" | "url" | null>(null);

  const copy = async (which: "wallet" | "url", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Fall through silently — the wallet text is already on screen.
    }
  };

  return (
    <div className="flex flex-col gap-2 overflow-hidden rounded-[10px] border border-[color:rgba(30,102,66,0.24)] bg-[color:rgba(30,102,66,0.06)] px-4 py-3">
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        Public identity
      </span>
      <span
        className="break-all font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-accent)]"
        style={{ letterSpacing: 0 }}
      >
        {wallet}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        <a
          href={profileUrl}
          target="_blank"
          rel="noreferrer"
          title={profileUrl}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: 0 }}
        >
          <span className="shrink-0">↗</span>
          <span className="min-w-0 truncate">
            averray.com/agents/{middleTruncate(wallet, 14)}
          </span>
        </a>
        <button
          type="button"
          onClick={() => copy("url", profileUrl)}
          className="inline-flex shrink-0 items-center rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2 py-1.5 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.06em" }}
        >
          {copied === "url" ? "Copied" : "Copy URL"}
        </button>
        <button
          type="button"
          onClick={() => copy("wallet", wallet)}
          className="inline-flex shrink-0 items-center rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2 py-1.5 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.06em" }}
        >
          {copied === "wallet" ? "Copied" : "Copy wallet"}
        </button>
      </div>
    </div>
  );
}

const STATUS_PILL: Record<
  AgentActiveSession["status"],
  { label: string; cls: string }
> = {
  claimed: {
    label: "Claimed",
    cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
  },
  working: {
    label: "Working",
    cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
  },
  submitted: {
    label: "Submitted · pending verification",
    cls: "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
  },
  disputed: {
    label: "Disputed",
    cls: "bg-[#f3d9d9] text-[#8a2a2a]",
  },
};

function ActiveSessionCard({ session }: { session: AgentActiveSession }) {
  const pill = STATUS_PILL[session.status];
  return (
    <div className="grid gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase",
            pill.cls
          )}
          style={{ letterSpacing: "0.08em" }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {pill.label}
        </span>
        {session.deadlineAt ? (
          <span
            className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            deadline {formatDeadline(session.deadlineAt)}
          </span>
        ) : null}
      </div>
      {session.title ? (
        <p className="m-0 text-[14px] font-semibold leading-tight text-[var(--avy-ink)]">
          {session.title}
        </p>
      ) : null}
      <dl
        className="grid grid-cols-1 gap-x-3 gap-y-1 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] sm:grid-cols-[auto_minmax(0,1fr)]"
        style={{ letterSpacing: 0 }}
      >
        <SessionField label="Job" value={session.jobId} />
        <SessionField label="Run" value={session.runId} />
        <SessionField label="Session" value={session.sessionId} />
        {session.lastEvent ? (
          <SessionField
            label="Last event"
            value={
              session.lastEventAt
                ? `${session.lastEvent} · ${formatRelative(session.lastEventAt)}`
                : session.lastEvent
            }
          />
        ) : null}
      </dl>
    </div>
  );
}

function SessionField({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </dt>
      <dd className="m-0 min-w-0 break-words">{value}</dd>
    </div>
  );
}

/**
 * Recent runs section. The previous version always listed the static
 * fixture; with first-agent state we need an explicit empty/active
 * vocabulary so an operator immediately knows what they're looking at.
 */
function RecentRunsBlock({ agent }: { agent: AgentRecord }) {
  const verified = agent.recentRuns;
  const session = agent.activeSession;

  if (verified.length === 0) {
    const copy = !session
      ? "No verified runs yet."
      : session.status === "submitted"
        ? "1 active run · submitted, awaiting verification."
        : session.status === "disputed"
          ? "1 active run · in dispute."
          : `1 active run · ${session.status}.`;
    return (
      <div
        className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {copy}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {session ? (
        <div
          className="rounded-[8px] border border-dashed border-[color:rgba(30,102,66,0.35)] bg-[color:rgba(30,102,66,0.04)] px-3.5 py-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-accent)]"
          style={{ letterSpacing: 0 }}
        >
          1 active run · {session.status} · {session.jobId}
        </div>
      ) : null}
      {verified.map((r) => {
        const pillCls =
          r.state === "Verified"
            ? "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
            : r.state === "Disputed"
              ? "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]"
              : "bg-[#ebe7da] text-[#756d58]";
        return (
          <div
            key={r.id}
            className="grid items-center gap-3 rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-3 py-2"
            style={{ gridTemplateColumns: "1fr auto auto" }}
          >
            <div>
              <div className="text-[13px] leading-tight text-[var(--avy-ink)]">
                {r.title}
              </div>
              <span
                className="mt-0.5 block font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                {r.id}
              </span>
            </div>
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-accent)]"
              style={{ letterSpacing: 0 }}
            >
              {r.receipt}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
                pillCls
              )}
              style={{ letterSpacing: "0.08em" }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              {r.state}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SubcontractingBlock({ agent }: { agent: AgentRecord }) {
  const lineage = agent.lineage ?? { delegated: [], subcontracted: [] };
  const stats = agent.lineageStats ?? {
    delegated: lineage.delegated.length,
    subcontracted: lineage.subcontracted.length,
  };
  const hasLineage =
    stats.delegated > 0 ||
    stats.subcontracted > 0 ||
    lineage.delegated.length > 0 ||
    lineage.subcontracted.length > 0;

  if (!hasLineage) {
    return (
      <div
        className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        No sub-contracting history yet.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <LineageStat label="Delegated out" value={stats.delegated} />
        <LineageStat label="Worked as sub-job" value={stats.subcontracted} />
      </div>

      {lineage.delegated.length > 0 ? (
        <div className="grid gap-1.5">
          <LineageGroupLabel label="Delegated sessions" />
          {lineage.delegated.slice(0, 3).map((entry) => (
            <DelegatedLineageCard key={entry.sessionId} entry={entry} />
          ))}
          {lineage.delegated.length > 3 ? (
            <LineageMore count={lineage.delegated.length - 3} label="delegated session" />
          ) : null}
        </div>
      ) : null}

      {lineage.subcontracted.length > 0 ? (
        <div className="grid gap-1.5">
          <LineageGroupLabel label="Sub-job work" />
          {lineage.subcontracted.slice(0, 3).map((entry) => (
            <SubcontractedLineageCard key={entry.sessionId} entry={entry} />
          ))}
          {lineage.subcontracted.length > 3 ? (
            <LineageMore count={lineage.subcontracted.length - 3} label="sub-job session" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LineageStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2">
      <span
        className="block font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        {label}
      </span>
      <span
        className="mt-1 block font-[family-name:var(--font-mono)] text-[18px] font-semibold tabular-nums text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        {value}
      </span>
    </div>
  );
}

function LineageGroupLabel({ label }: { label: string }) {
  return (
    <span
      className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
      style={{ letterSpacing: "0.1em" }}
    >
      {label}
    </span>
  );
}

function DelegatedLineageCard({ entry }: { entry: AgentDelegatedLineage }) {
  const childJobs = entry.children.jobIds.slice(0, 2);
  return (
    <div className="rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-semibold leading-tight text-[var(--avy-ink)]">
            {entry.jobTitle || titleFromJobId(entry.jobId)}
          </p>
          <p
            className="m-0 mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            {middleTruncate(entry.sessionId, 18)} · {relativeOrFallback(entry.updatedAt)}
          </p>
        </div>
        <LineageStatus label={entry.status} />
      </div>
      <div
        className="mt-2 flex flex-wrap items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>{entry.children.count} child job{entry.children.count === 1 ? "" : "s"}</span>
        {childJobs.map((jobId) => (
          <span
            key={jobId}
            className="rounded-[5px] bg-[color:rgba(30,102,66,0.08)] px-1.5 py-0.5 text-[var(--avy-accent)]"
            title={jobId}
          >
            {middleTruncate(jobId, 18)}
          </span>
        ))}
      </div>
    </div>
  );
}

function SubcontractedLineageCard({ entry }: { entry: AgentSubcontractedLineage }) {
  return (
    <div className="rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-semibold leading-tight text-[var(--avy-ink)]">
            {entry.jobTitle || titleFromJobId(entry.jobId)}
          </p>
          <p
            className="m-0 mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            {middleTruncate(entry.sessionId, 18)} · {relativeOrFallback(entry.updatedAt)}
          </p>
        </div>
        <LineageStatus label={entry.status} />
      </div>
      <div
        className="mt-2 flex flex-wrap items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {entry.parent.wallet ? (
          <span>parent wallet {middleTruncate(entry.parent.wallet, 18)}</span>
        ) : (
          <span>parent session {middleTruncate(entry.parent.sessionId ?? "unknown", 18)}</span>
        )}
        {entry.parent.jobId ? (
          <span
            className="rounded-[5px] bg-[color:rgba(30,102,66,0.08)] px-1.5 py-0.5 text-[var(--avy-accent)]"
            title={entry.parent.jobId}
          >
            {middleTruncate(entry.parent.jobId, 18)}
          </span>
        ) : null}
        {entry.parent.isSelf ? <span>self-delegated</span> : null}
      </div>
    </div>
  );
}

function LineageStatus({ label }: { label: string }) {
  return (
    <span
      className="shrink-0 rounded-full bg-[var(--avy-accent-soft)] px-2 py-0.5 font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-accent)]"
      style={{ letterSpacing: "0.08em" }}
    >
      {label || "unknown"}
    </span>
  );
}

function LineageMore({ count, label }: { count: number; label: string }) {
  return (
    <div
      className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
      style={{ letterSpacing: 0 }}
    >
      +{count} more {label}{count === 1 ? "" : "s"}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <p
        className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)]" />
        {title}
      </p>
      {children}
    </section>
  );
}

function StakeCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "bad";
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2">
      <span
        className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        {label}
      </span>
      <span
        className={cn(
          "font-[family-name:var(--font-mono)] text-[14px] tabular-nums",
          tone === "warn" && "text-[var(--avy-warn)]",
          tone === "bad" && "text-[#8a2a2a]",
          !tone && "text-[var(--avy-ink)]"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function middleTruncate(value: string, keep: number): string {
  if (value.length <= keep + 3) return value;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  return `${Math.round(deltaHr / 24)}d ago`;
}

function relativeOrFallback(iso: string): string {
  return iso ? formatRelative(iso) : "time unknown";
}

function formatDeadline(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = Math.round((t - Date.now()) / 1000);
  if (deltaSec <= 0) return "expired";
  if (deltaSec < 60) return `in ${deltaSec}s`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `in ${deltaMin}m`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `in ${deltaHr}h`;
  return `in ${Math.round(deltaHr / 24)}d`;
}

function titleFromJobId(jobId: string): string {
  return jobId
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || jobId;
}
