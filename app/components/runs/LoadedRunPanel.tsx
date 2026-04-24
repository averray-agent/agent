"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { SourceBadge } from "./StatePill";
import type { GitHubJobContext } from "./types";

export interface StakeBreakdown {
  worker: string;
  verifier: string;
  treasury: string;
}

export interface VerifierLine {
  time: string;
  level: "info" | "ok" | "warn";
  label: string;
  message: React.ReactNode;
}

export interface VerifierVerdict {
  status: string;
  score: string;
  scoreLabel: string;
}

export interface LoadedRunPanelProps {
  kicker: string;
  title: string;
  meta: string;
  stake: {
    amount: string;
    aux: string;
    breakdown: StakeBreakdown;
  };
  evidence: {
    tabs: { id: string; label: string; sub?: string }[];
    activeTab?: string;
    sample: string;
    metaRight: string;
    metaFoot: string;
  };
  submission: {
    note: React.ReactNode;
    cta: string;
    onSubmit?: (evidence: string) => void | Promise<void>;
    submitting?: boolean;
    error?: string | null;
  };
  verifier: {
    runner: string;
    elapsed: string;
    lines: VerifierLine[];
    verdict: VerifierVerdict;
    modeNote: string;
  };
  settle: {
    title: string;
    detail: React.ReactNode;
    cta: string;
    ctaDisabled?: boolean;
    note: string;
  };
  /**
   * When the loaded run was ingested from GitHub, the panel renders a
   * "Job context" block in the left column with labels, score, issue body,
   * acceptance criteria, agent instructions, verification signals, and an
   * "Open GitHub Issue" link. Absent = native job, no extra block.
   */
  github?: GitHubJobContext;
}

export function LoadedRunPanel(props: LoadedRunPanelProps) {
  const [activeTab, setActiveTab] = useState(
    props.evidence.activeTab ?? props.evidence.tabs[0]?.id
  );
  const [evidenceValue, setEvidenceValue] = useState(props.evidence.sample);

  useEffect(() => {
    setEvidenceValue(props.evidence.sample);
  }, [props.evidence.sample]);

  return (
    <section
      aria-label="Loaded run"
      className="overflow-hidden rounded-[12px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-dense)]"
    >
      <header className="flex items-center justify-between gap-3.5 border-b border-[var(--avy-line-soft)] bg-gradient-to-b from-[#faf8f1] to-[#fffdf7] px-4.5 py-3.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <div>
            <div
              className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
              style={{ letterSpacing: "0.14em" }}
            >
              {props.kicker}
            </div>
            <h2 className="m-0 font-[family-name:var(--font-display)] text-[18px] font-bold leading-[1.1]">
              {props.title}
            </h2>
          </div>
          <span
            className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            {props.meta}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <SmallGhostBtn>⌕ Receipt preview</SmallGhostBtn>
          <SmallGhostBtn>Open in new tab ↗</SmallGhostBtn>
          <button
            type="button"
            title="Close"
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-[6px] border border-[var(--avy-line)] bg-transparent text-sm text-[var(--avy-muted)] hover:border-[var(--avy-ink)] hover:text-[var(--avy-ink)]"
          >
            ×
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* LEFT */}
        <div className="flex flex-col gap-3.5 border-r-0 border-b border-[var(--avy-line-soft)] bg-[#fffdf7] p-4 lg:border-b-0 lg:border-r">
          {/* Job context (GitHub-ingested jobs only) */}
          {props.github ? <GitHubContextBlock context={props.github} /> : null}

          {/* Stake */}
          <div>
            <BlockLabel right={<>▪ locked in AgentAccountCore</>}>Stake</BlockLabel>
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2.5 rounded-[8px] border border-[color:rgba(30,102,66,0.22)] bg-[color:rgba(30,102,66,0.04)] px-3.5 py-3">
              <div>
                <div className="font-[family-name:var(--font-display)] text-[26px] font-bold leading-none text-[var(--avy-ink)]">
                  {props.stake.amount}
                  <span
                    className="ml-1 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--avy-muted)]"
                    style={{ letterSpacing: 0 }}
                  >
                    DOT
                  </span>
                </div>
                <p
                  className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  {props.stake.aux}
                </p>
              </div>
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--avy-accent-soft)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.12em" }}
              >
                ● Locked
              </span>
              <div
                className="col-span-full grid grid-cols-3 gap-2 border-t border-[color:rgba(30,102,66,0.14)] pt-2.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                <BreakItem label="Worker" value={props.stake.breakdown.worker} />
                <BreakItem label="Verifier" value={props.stake.breakdown.verifier} />
                <BreakItem label="Treasury" value={props.stake.breakdown.treasury} />
              </div>
            </div>
          </div>

          {/* Evidence */}
          <div>
            <BlockLabel
              right={
                <span className="font-[family-name:var(--font-mono)] text-[var(--avy-muted)]">
                  {props.evidence.metaRight}
                </span>
              }
            >
              Evidence
            </BlockLabel>
            <div className="flex flex-col overflow-hidden rounded-[8px] border border-[var(--avy-line)] bg-white">
              <div className="flex items-center gap-2 border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-2.5 py-1.5">
                {props.evidence.tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={cn(
                      "rounded-[5px] px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]",
                      activeTab === t.id &&
                        "bg-[var(--avy-paper-solid)] text-[var(--avy-ink)] shadow-[inset_0_0_0_1px_var(--avy-line)]"
                    )}
                    style={{ letterSpacing: "0.12em" }}
                  >
                    {t.label}
                    {t.sub ? (
                      <small className="ml-1 opacity-50" style={{ letterSpacing: 0 }}>
                        {t.sub}
                      </small>
                    ) : null}
                  </button>
                ))}
                <span className="flex-1" />
                <span
                  className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  {props.evidence.metaFoot}
                </span>
              </div>
              <textarea
                spellCheck={false}
                value={evidenceValue}
                onChange={(event) => setEvidenceValue(event.target.value)}
                className="min-h-[150px] resize-y border-0 bg-transparent px-3 py-3 font-[family-name:var(--font-mono)] text-xs leading-[1.55] text-[var(--avy-ink)] outline-none"
                style={{ letterSpacing: 0 }}
              />
              <div
                className="flex items-center justify-between border-t border-[var(--avy-line-soft)] bg-[#faf8f1] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                <span className="inline-flex items-center gap-1 text-[var(--avy-accent)]">
                  ＋ Attach file
                </span>
                <span>sha256 0x9c…41 · autosave 4s ago</span>
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--avy-line)] bg-[#fffdf7] px-3.5 py-3">
            <p
              className="m-0 flex-1 min-w-0 font-[family-name:var(--font-mono)] text-[11px] leading-[1.4] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {props.submission.note}
            </p>
            <button
              type="button"
              disabled={props.submission.submitting}
              onClick={() => {
                props.submission.onSubmit?.(evidenceValue);
              }}
              className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
              style={{ letterSpacing: "0.04em" }}
            >
              {props.submission.submitting ? "Submitting..." : props.submission.cta}
              <span
                className="rounded-[3px] bg-black/20 px-1.5 py-px font-[family-name:var(--font-mono)] text-[10.5px] font-medium text-white/70"
                style={{ letterSpacing: 0 }}
              >
                ⏎
              </span>
            </button>
            {props.submission.error ? (
              <span
                className="font-[family-name:var(--font-mono)] text-[11px] text-[#8c2a17]"
                style={{ letterSpacing: 0 }}
              >
                {props.submission.error}
              </span>
            ) : null}
          </div>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-3.5 bg-[#faf8f1] p-4">
          {/* Verifier */}
          <div>
            <BlockLabel right={<span className="lock">{props.verifier.modeNote}</span>}>
              Verifier output
            </BlockLabel>
            <div className="overflow-hidden rounded-[8px] border border-[color:rgba(30,102,66,0.18)] bg-[#131715] text-[#f5f3ee]">
              <div
                className="flex items-center justify-between border-b border-white/5 bg-[#0f1210] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[#9ba29c]"
                style={{ letterSpacing: 0 }}
              >
                <span>
                  {props.verifier.runner.split(" · ").map((part, i) => (
                    <span key={i}>
                      {i > 0 ? " · " : null}
                      {i === 1 ? <b className="text-[#cfe8dc]">{part}</b> : part}
                    </span>
                  ))}
                </span>
                <span>{props.verifier.elapsed}</span>
              </div>
              <div
                className="px-3.5 py-3 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.6]"
                style={{ letterSpacing: 0 }}
              >
                {props.verifier.lines.map((line, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[44px_92px_1fr] gap-2.5"
                  >
                    <span className="text-[#6c7a72]">{line.time}</span>
                    <span
                      className={cn(
                        "font-semibold",
                        line.level === "info" && "text-[#a5c8ef]",
                        line.level === "ok" && "text-[#9bd7b5]",
                        line.level === "warn" && "text-[#f4c989]"
                      )}
                    >
                      {line.label}
                    </span>
                    <span className="text-[#e7ebe5]">{line.message}</span>
                  </div>
                ))}
              </div>
              <div
                className="flex items-center justify-between border-t border-white/5 bg-[color:rgba(30,102,66,0.18)] px-3 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[#d6eadf]"
                style={{ letterSpacing: "0.12em" }}
              >
                <span>● {props.verifier.verdict.status}</span>
                <span
                  className="font-[family-name:var(--font-mono)] text-[11.5px] text-[#9bd7b5]"
                  style={{ letterSpacing: 0 }}
                >
                  {props.verifier.verdict.score} · {props.verifier.verdict.scoreLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Settle */}
          <div>
            <BlockLabel
              right={
                <span className="font-[family-name:var(--font-mono)] text-[var(--avy-muted)]">
                  {props.settle.note}
                </span>
              }
            >
              Settlement
            </BlockLabel>
            <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[color:rgba(30,102,66,0.30)] bg-gradient-to-b from-[color:rgba(30,102,66,0.08)] to-[color:rgba(30,102,66,0.02)] px-3.5 py-3">
              <div className="grid gap-1">
                <span
                  className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
                  style={{ letterSpacing: "0.12em" }}
                >
                  {props.settle.title}
                </span>
                <span
                  className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  {props.settle.detail}
                </span>
              </div>
              <button
                type="button"
                disabled={props.settle.ctaDisabled}
                className="inline-flex h-8 items-center gap-2 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-xs font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)] disabled:pointer-events-none disabled:opacity-40"
                style={{ letterSpacing: "0.04em" }}
              >
                {props.settle.cta}
              </button>
            </div>
            <div className="mt-2 flex gap-1.5">
              <SmallGhostBtn className="flex-1">Request cosign</SmallGhostBtn>
              <SmallGhostBtn>Raise dispute</SmallGhostBtn>
              <SmallGhostBtn>Unwind</SmallGhostBtn>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function GitHubContextBlock({ context }: { context: GitHubJobContext }) {
  return (
    <div>
      <BlockLabel
        right={
          <a
            href={context.issueUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[var(--avy-accent)] hover:underline"
          >
            Open GitHub issue ↗
          </a>
        }
      >
        Job context
      </BlockLabel>
      <div className="overflow-hidden rounded-[8px] border border-[var(--avy-line)] bg-white">
        {/* Header: source + repo + issue + score */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-3 py-2">
          <SourceBadge kind="github" />
          <a
            href={context.issueUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)] hover:text-[var(--avy-accent)]"
            style={{ letterSpacing: 0 }}
          >
            {context.repo}
            <span className="ml-0.5 text-[var(--avy-accent)]">
              #{context.issueNumber}
            </span>
          </a>
          <span className="opacity-40">·</span>
          <span
            className="font-[family-name:var(--font-mono)] text-[11px] uppercase text-[var(--avy-muted)]"
            style={{ letterSpacing: "0.08em" }}
          >
            {context.category}
          </span>
          {typeof context.score === "number" ? (
            <span className="ml-auto inline-flex items-center gap-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
              Fit score{" "}
              <b className="font-semibold text-[var(--avy-ink)]">{context.score}</b>
              <span className="text-[var(--avy-muted)]">/100</span>
            </span>
          ) : null}
        </div>

        {/* Body */}
        <div className="px-3.5 py-3">
          {/* Title */}
          <h3 className="m-0 font-[family-name:var(--font-display)] text-[14px] font-bold leading-[1.3] text-[var(--avy-ink)]">
            {context.title}
          </h3>

          {/* Labels */}
          {context.labels && context.labels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {context.labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center rounded-full border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.03)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-ink)]"
                  style={{ letterSpacing: 0 }}
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}

          {/* Body / description */}
          <p
            className="mt-3 max-h-[140px] overflow-y-auto whitespace-pre-wrap font-[family-name:var(--font-body)] text-[12.5px] leading-[1.5] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            {context.body}
          </p>

          {/* Acceptance criteria */}
          {context.acceptanceCriteria.length > 0 ? (
            <div className="mt-3">
              <div
                className="mb-1 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Acceptance criteria
              </div>
              <ul className="m-0 flex flex-col gap-1 pl-0">
                {context.acceptanceCriteria.map((item, i) => (
                  <li
                    key={i}
                    className="flex gap-2 font-[family-name:var(--font-body)] text-[12px] leading-[1.45] text-[var(--avy-ink)]"
                    style={{ letterSpacing: 0 }}
                  >
                    <span className="mt-[7px] h-[4px] w-[4px] shrink-0 rounded-full bg-[var(--avy-accent)]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Agent instructions */}
          {context.agentInstructions ? (
            <div className="mt-3">
              <div
                className="mb-1 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Agent instructions
              </div>
              <p
                className="m-0 rounded-[6px] border border-[color:rgba(30,102,66,0.18)] bg-[color:rgba(30,102,66,0.04)] px-2.5 py-2 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.5] text-[var(--avy-ink)]"
                style={{ letterSpacing: 0 }}
              >
                {context.agentInstructions}
              </p>
            </div>
          ) : null}

          {/* Verification */}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--avy-line-soft)] pt-2.5">
            <span
              className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.14em" }}
            >
              Verification
            </span>
            <span
              className="inline-flex items-center rounded-full bg-[color:rgba(17,19,21,0.06)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              {context.verification.method}
            </span>
            {context.verification.signals.map((s) => (
              <span
                key={s}
                className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                · {s}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BlockLabel({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div
      className="mb-1.5 flex items-center justify-between gap-2 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
      style={{ letterSpacing: "0.14em" }}
    >
      <span>{children}</span>
      {right ? (
        <span
          className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.06em" }}
        >
          {right}
        </span>
      ) : null}
    </div>
  );
}

function BreakItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {label}
      <b
        className="mt-px block text-xs font-semibold text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        {value}
      </b>
    </div>
  );
}

function SmallGhostBtn({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center justify-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:bg-white",
        className
      )}
      style={{ letterSpacing: "0.04em" }}
    >
      {children}
    </button>
  );
}
