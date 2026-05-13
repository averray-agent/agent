"use client";

import { useCallback } from "react";

/**
 * Visible filter controls for the timeline event panels (job and
 * session). The backend `/admin/jobs/timeline` endpoint accepts
 * `sources`, `topics`, `eventWallet`, and `correlationId` query
 * params; this rail surfaces those four knobs so an auditor can slice
 * a long timeline without leaving the page. The same control set is
 * reused on the session drawer (client-side filter — see
 * SessionDrawerBody for the why).
 */

export interface TimelineEventFilterValue {
  source: string;
  topic: string;
  wallet: string;
  correlationId: string;
}

export const EMPTY_TIMELINE_EVENT_FILTERS: TimelineEventFilterValue = {
  source: "",
  topic: "",
  wallet: "",
  correlationId: "",
};

export function isTimelineEventFilterActive(value: TimelineEventFilterValue): boolean {
  return Boolean(
    value.source.trim() ||
      value.topic.trim() ||
      value.wallet.trim() ||
      value.correlationId.trim()
  );
}

export interface TimelineEventFiltersProps {
  value: TimelineEventFilterValue;
  onChange: (next: TimelineEventFilterValue) => void;
  /** When provided, override the default `id` prefix so two filter
   *  rails on the same page (e.g. job + session) keep distinct
   *  input ids for label-input association. */
  idPrefix?: string;
}

export function TimelineEventFilters({
  value,
  onChange,
  idPrefix = "tl-evt-filter",
}: TimelineEventFiltersProps) {
  const set = useCallback(
    <K extends keyof TimelineEventFilterValue>(key: K, next: string) =>
      onChange({ ...value, [key]: next }),
    [onChange, value]
  );
  const active = isTimelineEventFilterActive(value);

  return (
    <div
      role="search"
      aria-label="Filter timeline events"
      className="flex flex-wrap items-end gap-2 rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] p-2.5"
    >
      <Field
        id={`${idPrefix}-source`}
        label="Source"
        placeholder="state, event_bus…"
        value={value.source}
        onChange={(v) => set("source", v)}
      />
      <Field
        id={`${idPrefix}-topic`}
        label="Topic"
        placeholder="job.claimed, session…"
        value={value.topic}
        onChange={(v) => set("topic", v)}
      />
      <Field
        id={`${idPrefix}-wallet`}
        label="Wallet"
        placeholder="0x…"
        value={value.wallet}
        onChange={(v) => set("wallet", v)}
      />
      <Field
        id={`${idPrefix}-correlation-id`}
        label="Correlation id"
        placeholder="ses_… / req_…"
        value={value.correlationId}
        onChange={(v) => set("correlationId", v)}
      />
      <button
        type="button"
        onClick={() => onChange(EMPTY_TIMELINE_EVENT_FILTERS)}
        disabled={!active}
        className="h-8 self-end rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ letterSpacing: "0.08em" }}
      >
        Clear
      </button>
    </div>
  );
}

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-w-[150px] flex-1 flex-col gap-1">
      <span
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </span>
      <input
        id={id}
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:border-[color:rgba(30,102,66,0.3)] focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[color:rgba(30,102,66,0.26)]"
        style={{ letterSpacing: 0 }}
      />
    </label>
  );
}

/**
 * Parse the four params from a URLSearchParams-compatible source. Used
 * by both the runs/detail page and the sessions page so a refresh /
 * shared link reproduces the filtered view. Accepts Next.js'
 * `ReadonlyURLSearchParams` because that's what `useSearchParams()`
 * returns — only `.get()` is needed here.
 */
export interface ReadableSearchParams {
  get(name: string): string | null;
}

export function parseTimelineEventFilters(
  params: ReadableSearchParams | null | undefined
): TimelineEventFilterValue {
  if (!params) return EMPTY_TIMELINE_EVENT_FILTERS;
  return {
    source: params.get("source")?.trim() ?? "",
    topic: params.get("topic")?.trim() ?? "",
    wallet: params.get("wallet")?.trim() ?? "",
    correlationId: params.get("correlationId")?.trim() ?? "",
  };
}

/** Mutates the given URLSearchParams in place — sets present keys,
 *  removes empty ones — so callers can stitch the timeline filter
 *  state into a larger URL that may already carry unrelated params. */
export function applyTimelineEventFiltersToParams(
  params: URLSearchParams,
  value: TimelineEventFilterValue
): URLSearchParams {
  const fields: Array<keyof TimelineEventFilterValue> = [
    "source",
    "topic",
    "wallet",
    "correlationId",
  ];
  for (const key of fields) {
    const next = value[key].trim();
    if (next) params.set(key, next);
    else params.delete(key);
  }
  return params;
}
