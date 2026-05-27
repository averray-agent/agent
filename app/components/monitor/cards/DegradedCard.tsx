"use client";

// Hermes Handoff Monitor — DegradedCard
//
// Hand-built card variant for the two states where the live Card
// shape isn't trustworthy: `failed-fetch` (upstream returned an
// error) and `source-offline` (upstream unreachable). Mirrors the
// bundle's `CustomCard` component 1:1.
//
// Visual contract:
//   - failed-fetch → rose ribbon, ERROR pill, "Retry now" action
//   - source-offline → neutral grey, OFFLINE pill, "View cached"
//                       action (no urgency — we don't know what's
//                       happening upstream)
//
// The hard rule from §16 of the spec: zero tolerance for hiding
// "we don't know if there's action needed." A failed-fetch card
// must be obviously not-fresh; an offline card must not pretend
// we have current data.

import type { ReactNode } from "react";
import type { BoardCard } from "@/lib/monitor/card-types.js";

export type DegradedCardKind = "failed-fetch" | "source-offline";

export type DegradedCardProps = {
  card: BoardCard;
  /** Operator-facing body copy explaining what happened. */
  body: ReactNode;
  /** Pill labels (e.g. ["fetch failed", "retry in 28s"]). */
  pills: ReadonlyArray<readonly [pillClass: string, label: string]>;
  /** Primary action label (e.g. "Retry now", "View cached"). */
  action: string;
  /** Click handler — typically wired to a retry / refresh in M4+. */
  onAction?: () => void;
  /** Card click handler — typically opens a context drawer in M5+. */
  onClick?: (card: BoardCard) => void;
};

export function DegradedCard({
  card,
  body,
  pills,
  action,
  onAction,
  onClick,
}: DegradedCardProps) {
  const kind: DegradedCardKind = card.state === "source-offline" ? "source-offline" : "failed-fetch";
  const isErr = kind === "failed-fetch";

  return (
    <div
      className={"hm-card " + (isErr ? "hm-card--err" : "hm-card--offline")}
      onClick={onClick ? () => onClick(card) : undefined}
      tabIndex={-1}
      data-card-id={card.id}
      data-card-state={kind}
      role={onClick ? "button" : "article"}
      aria-label={`${card.id} — ${isErr ? "error" : "offline"}: ${card.title}`}
    >
      <div className="hm-card-head">
        <span className="hm-card-id">
          <span className="agent-dot agent-dot--ext" aria-hidden />
          <strong className="hm-mono">{card.id}</strong>
        </span>
        <span className="hm-card-fresh">
          <span
            className="fresh-dot"
            style={{
              background: isErr ? "var(--hm-rose)" : "var(--hm-offline)",
            }}
            aria-hidden
          />
          {isErr ? "ERROR" : "OFFLINE"}
        </span>
      </div>

      <div
        className="hm-card-title"
        style={{ color: isErr ? "var(--hm-rose)" : "var(--hm-muted)" }}
      >
        {body}
      </div>

      <div className="hm-pillrow">
        {pills.map(([cls, label]) => (
          <span key={label} className={"hm-pill " + cls}>
            {label}
          </span>
        ))}
      </div>

      <div className="hm-card-cta">
        <button
          type="button"
          className="hm-btn hm-btn--ghost hm-btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            onAction?.();
          }}
          disabled={!onAction}
        >
          {action}
        </button>
      </div>
    </div>
  );
}
