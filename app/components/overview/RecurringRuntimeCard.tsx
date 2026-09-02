"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Flame, Pause, Play, RotateCw } from "lucide-react";
import { mutate } from "swr";
import { SectionHead } from "./SectionHead";
import { swrFetcher } from "@/lib/api/client";
import { useAuthSession } from "@/lib/api/hooks";
import {
  buildAuthSession,
  canUseControl,
  type ControlGate,
} from "@/lib/auth/capabilities";
import {
  postRecurringTemplateAction,
  refreshRecurringTemplateSurfaces,
  type RecurringRuntimeSummary,
  type RecurringTemplateAction,
  type RecurringTemplateState,
  type RecurringTemplateStatus,
} from "@/lib/api/recurring-jobs";
import { cn } from "@/lib/utils/cn";

/**
 * Per-action capability mapping. Matches the keys the backend
 * declares in `capabilityMatrix.uiControls` so each button gates on
 * exactly the capability the matching admin endpoint requires.
 */
const ACTION_CONTROL: Record<RecurringTemplateAction, string> = {
  pause: "admin.jobs.pauseRecurring",
  resume: "admin.jobs.resumeRecurring",
  fire: "admin.jobs.fireRecurring",
};

export interface RecurringRuntimeCardProps {
  runtime: RecurringRuntimeSummary;
}

const STATE_LABEL: Record<RecurringTemplateState, string> = {
  scheduled: "Scheduled",
  paused: "Paused",
  exhausted: "Reserve exhausted",
  attention: "Needs attention",
};

export function RecurringRuntimeCard({ runtime }: RecurringRuntimeCardProps) {
  const meta = runtime.enabled
    ? `${runtime.running ? "scheduler running" : "scheduler idle"} · ${runtime.count} templates`
    : `${runtime.count} templates · scheduler disabled`;

  return (
    <section>
      <SectionHead title="Recurring jobs" meta={meta} />
      <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
        {runtime.templates.length === 0 ? (
          <EmptyRow enabled={runtime.enabled} />
        ) : (
          runtime.templates.map((template) => (
            <RecurringTemplateRow key={template.templateId} template={template} />
          ))
        )}
      </div>
    </section>
  );
}

function RecurringTemplateRow({ template }: { template: RecurringTemplateStatus }) {
  const [pending, setPending] = useState<RecurringTemplateAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRequest = useAuthSession();
  const session = useMemo(
    () => buildAuthSession(sessionRequest.data),
    [sessionRequest.data]
  );
  const gates: Record<RecurringTemplateAction, ControlGate> = {
    pause: canUseControl(session, ACTION_CONTROL.pause),
    resume: canUseControl(session, ACTION_CONTROL.resume),
    fire: canUseControl(session, ACTION_CONTROL.fire),
  };
  const reserve = template.reserve;
  const finiteReserve = reserve.mode === "finite" && reserve.reserveAmount !== undefined;
  const fillPct =
    finiteReserve && reserve.reserveAmount && reserve.reserveAmount > 0
      ? Math.min(100, Math.round(((reserve.consumedAmount ?? 0) / reserve.reserveAmount) * 100))
      : 0;

  const onAction = async (action: RecurringTemplateAction) => {
    setError(null);
    setPending(action);
    try {
      await postRecurringTemplateAction(swrFetcher, template.templateId, action);
      await refreshRecurringTemplateSurfaces(mutate);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} template.`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-3 border-b border-[var(--avy-line-soft)] p-[0.95rem_1.15rem] last:border-b-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-[family-name:var(--font-display)] text-[14px] font-bold text-[var(--avy-ink)]">
            {template.templateId}
          </span>
          <StatePill state={template.state} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          <span>{template.scheduleLabel}</span>
          <span>·</span>
          <span>{template.category}</span>
          {template.tier ? (
            <>
              <span>·</span>
              <span>{template.tier}</span>
            </>
          ) : null}
        </div>
      </div>

      <MetricStack
        label="next fire"
        value={
          template.exhausted
            ? "stopped"
            : template.paused
              ? "paused"
              : formatDateTime(template.nextFireAt)
        }
        sub={
          template.lastFiredAt
            ? `last ${formatRelative(template.lastFiredAt)}`
            : "no fires yet"
        }
      />

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2 font-[family-name:var(--font-mono)] text-[12px]">
          <span className="text-[var(--avy-muted)]">reserve</span>
          <span className={template.exhausted ? "text-[var(--avy-warn)]" : "text-[var(--avy-ink)]"}>
            {formatReserve(template)}
          </span>
        </div>
        {finiteReserve ? (
          <div className="h-1 overflow-hidden rounded-full bg-[color:rgba(17,19,21,0.06)]">
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                template.exhausted ? "bg-[var(--avy-warn)]" : "bg-[var(--avy-accent)]"
              )}
              style={{ width: `${fillPct}%` }}
            />
          </div>
        ) : (
          <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
            unbounded metadata reserve
          </span>
        )}
        <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          {template.lastResult
            ? `last result ${template.lastResult.status}`
            : `${template.derivativeCount} derivative${template.derivativeCount === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-start gap-1.5 lg:justify-end">
        {template.paused ? (
          <ActionButton
            action="resume"
            label="Resume"
            pending={pending}
            disabled={!gates.resume.allowed}
            disabledReason={gates.resume.reason}
            icon={<Play size={13} />}
            onClick={() => onAction("resume")}
          />
        ) : (
          <ActionButton
            action="pause"
            label="Pause"
            pending={pending}
            disabled={!gates.pause.allowed}
            disabledReason={gates.pause.reason}
            icon={<Pause size={13} />}
            onClick={() => onAction("pause")}
          />
        )}
        <ActionButton
          action="fire"
          label="Fire"
          pending={pending}
          disabled={template.paused || template.exhausted || !gates.fire.allowed}
          disabledReason={
            template.paused
              ? "Resume the template first"
              : template.exhausted
                ? "Reserve exhausted"
                : gates.fire.reason
          }
          icon={<Flame size={13} />}
          onClick={() => onAction("fire")}
        />
        {template.latestRunId ? (
          <a
            href={`/runs?run=${encodeURIComponent(template.latestRunId)}`}
            className="inline-flex h-8 items-center rounded-full border border-[var(--avy-line)] bg-[var(--avy-paper)] px-2.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.08em" }}
          >
            Latest
          </a>
        ) : null}
        {error ? (
          <span className="basis-full text-right font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-warn)]">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MetricStack({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.12em" }}>
        {label}
      </span>
      <span className="min-w-0 break-words font-[family-name:var(--font-mono)] text-[12px] font-semibold text-[var(--avy-ink)]">
        {value}
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        {sub}
      </span>
    </div>
  );
}

function ActionButton({
  action,
  label,
  pending,
  disabled = false,
  disabledReason,
  icon,
  onClick,
}: {
  action: RecurringTemplateAction;
  label: string;
  pending: RecurringTemplateAction | null;
  disabled?: boolean;
  /** Human-readable hint shown on hover when the button is disabled.
   *  Capability-gate reasons surface here so the operator knows why
   *  the action isn't available. */
  disabledReason?: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  const active = pending === action;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending !== null || disabled}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] transition-colors",
        "hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--avy-line)] disabled:hover:text-[var(--avy-ink)]",
        active && "text-[var(--avy-accent)]"
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {active ? <RotateCw size={13} className="animate-spin" /> : icon}
      {active ? "Working" : label}
    </button>
  );
}

function StatePill({ state }: { state: RecurringTemplateState }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        state === "scheduled" && "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
        state === "paused" && "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]",
        state === "attention" && "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        state === "exhausted" && "bg-[#f3d7d4] text-[#a0322a]"
      )}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {STATE_LABEL[state]}
    </span>
  );
}

function EmptyRow({ enabled }: { enabled: boolean }) {
  return (
    <div className="p-[1.05rem_1.15rem] font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-muted)]">
      {enabled
        ? "No recurring templates are configured yet."
        : "Recurring scheduler status is unavailable right now."}
    </div>
  );
}

function formatReserve(template: RecurringTemplateStatus): string {
  const reserve = template.reserve;
  if (reserve.mode !== "finite") return reserve.mode;
  const remaining = formatAmount(reserve.remainingAmount ?? 0, reserve.rewardAsset);
  const total = formatAmount(reserve.reserveAmount ?? 0, reserve.rewardAsset);
  const runs = reserve.remainingRuns ?? 0;
  return `${remaining} / ${total} · ${runs} run${runs === 1 ? "" : "s"}`;
}

function formatAmount(value: number, asset: string): string {
  return `${trimNumber(value)} ${asset}`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "not scheduled";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(parsed));
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
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d ago`;
}
