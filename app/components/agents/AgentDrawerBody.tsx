"use client";

import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import { BadgeChip } from "./BadgeStrip";
import { TierChip } from "./TierChip";
import {
  BADGES,
  tierFor,
  nextThreshold,
  type AgentRecord,
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
  const profileUrl = `averray.com/agents/${agent.walletFull}`;

  return (
    <>
      <Section title="Signature header">
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-[color:rgba(30,102,66,0.24)] bg-[color:rgba(30,102,66,0.06)] px-4 py-3">
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
            {agent.walletFull}
          </span>
          <a
            href={`https://${profileUrl}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 self-start rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
            style={{ letterSpacing: 0 }}
          >
            <span>↗</span>
            <span>{profileUrl}</span>
          </a>
        </div>
      </Section>

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
            <Sparkline points={agent.sparkline} width={160} height={34} />
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

      <Section title={`Badges earned · ${agent.badges.length}`}>
        <div className="grid grid-cols-2 gap-2">
          {agent.badges.map((b) => {
            const def = BADGES[b];
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
                    issued {agent.badgeDates[b] ?? "—"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Recent runs · last 8">
        <div className="grid gap-1.5">
          {agent.recentRuns.map((r) => {
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
            No slashes on record — clean history since claim-open.
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

      <Section title="Public profile">
        <a
          href={`https://${profileUrl}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: 0 }}
        >
          <span>↗</span>
          <span>https://{profileUrl}</span>
          <span className="opacity-60">open</span>
        </a>
      </Section>
    </>
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
