"use client";

import { useMemo, useState } from "react";
import { mutate } from "swr";
import { swrFetcher } from "@/lib/api/client";
import { useAuthSession } from "@/lib/api/hooks";
import {
  buildAuthSession,
  canUseControl,
} from "@/lib/auth/capabilities";
import {
  availableActions,
  formatLifecycleLabel,
  LIFECYCLE_ACTION_LABEL,
  postJobLifecycleAction,
  type JobLifecycle,
  type JobLifecycleAction,
} from "@/lib/api/job-lifecycle";
import { cn } from "@/lib/utils/cn";

export interface LifecycleActionBarProps {
  jobId: string;
  lifecycle?: JobLifecycle;
}

/**
 * Operator action bar for the loaded run. Issues `POST
 * /admin/jobs/lifecycle` and revalidates the admin job feed +
 * `/admin/status` so the counts strip and lifecycle pills refresh.
 *
 * Hidden when the row carries no `lifecycle` block — that means the
 * row was loaded from the public `/jobs` feed and the operator
 * doesn't have admin auth for this surface.
 */
export function LifecycleActionBar({ jobId, lifecycle }: LifecycleActionBarProps) {
  const [pending, setPending] = useState<JobLifecycleAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRequest = useAuthSession();
  const session = useMemo(
    () => buildAuthSession(sessionRequest.data),
    [sessionRequest.data]
  );
  // All four lifecycle actions go through the same `admin.jobs.lifecycle`
  // UI control on the backend's capability matrix — one gate covers
  // Pause / Archive / Reopen / Mark stale.
  const gate = canUseControl(session, "admin.jobs.lifecycle");

  if (!lifecycle) return null;

  const actions = availableActions(lifecycle.state);

  const onClick = async (action: JobLifecycleAction) => {
    setError(null);
    setPending(action);
    try {
      await postJobLifecycleAction(swrFetcher, jobId, action);
      await Promise.all([mutate("/admin/jobs"), mutate("/admin/status")]);
    } catch {
      setError(
        `Could not ${LIFECYCLE_ACTION_LABEL[action].toLowerCase()} this job. Try again.`
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[0.7rem_0.95rem] shadow-[var(--shadow-card)]">
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        Lifecycle
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
          lifecycle.state === "open" &&
            "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
          lifecycle.state === "stale" &&
            "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
          (lifecycle.state === "paused" || lifecycle.state === "archived") &&
            "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: "0.1em" }}
      >
        {formatLifecycleLabel(lifecycle.state)}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => onClick(action)}
            disabled={pending !== null || !gate.allowed}
            title={gate.reason}
            className={cn(
              "rounded-full border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase transition-colors",
              "hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]",
              "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--avy-line)] disabled:hover:text-current",
              pending === action && "text-[var(--avy-accent)]"
            )}
            style={{ letterSpacing: "0.08em" }}
          >
            {pending === action ? "…" : LIFECYCLE_ACTION_LABEL[action]}
          </button>
        ))}
      </div>

      {!gate.allowed && gate.reason ? (
        <span
          className="basis-full font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {gate.reason}
        </span>
      ) : null}
      {error ? (
        <span className="basis-full font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-warn)]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
