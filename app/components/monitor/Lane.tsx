"use client";

// Hermes Handoff Monitor — Lane
//
// A single lane rendered in one of two visual modes:
//   - collapsed (mini-rail): vertical strip showing the lane's name
//     and card count. Clicking expands.
//   - expanded: full lane with header, optional action chip, and the
//     card list (or an empty placeholder when count === 0).
//
// M2 only renders the empty / mini-rail variants — cards land in M3.
// Card-list rendering is added then; for now the body shows either
// the empty-state copy or nothing (when collapsed).

import type { ReactNode } from "react";

export type LaneId =
  | "needs-attention"
  | "drafts"
  | "codex-needed"
  | "hermes-checking"
  | "operator-review"
  | "release-queue"
  | "deploying"
  | "done";

export type LaneDescriptor = {
  id: LaneId;
  name: string;
  /** Optional eyebrow / hint label shown under the lane title (e.g. "pre-check in flight"). */
  action?: string;
  /** When true the lane wears the amber action styling. */
  isAction?: boolean;
};

export type LaneProps = {
  lane: LaneDescriptor;
  /** Whether the lane is currently expanded (default) or collapsed to a mini-rail. */
  expanded: boolean;
  /** Number of cards in the lane. M2: usually 0 across the empty state. */
  count: number;
  /** Cards rendered into the body slot. M3 wires the actual <Card /> renders. */
  children?: ReactNode;
  /** Click handler to toggle this lane's expand/collapse state. */
  onToggle?: (id: LaneId) => void;
};

export function Lane({ lane, expanded, count, children, onToggle }: LaneProps) {
  if (!expanded) {
    return (
      <button
        type="button"
        className={"hm-lane hm-lane--collapsed " + (lane.isAction ? "hm-lane--action" : "")}
        onClick={() => onToggle?.(lane.id)}
        aria-label={`${lane.name} (${count} cards) — click to expand`}
        title={`${lane.name} (${count})`}
      >
        <div className="hm-lane-rail">
          <span className={"ct " + (count > 0 ? "ct--has" : "ct--zero")}>{count}</span>
          <span className="lbl">{lane.name}</span>
          <span className="icn" aria-hidden>›</span>
        </div>
      </button>
    );
  }

  const classes = [
    "hm-lane",
    count === 0 ? "" : "hm-lane--expanded",
    lane.isAction ? "hm-lane--action" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes} aria-label={`${lane.name} lane`}>
      <div className="hm-lane-head">
        <div className="hm-lane-head-row">
          <span className="hm-lane-title">{lane.name}</span>
          <span className="hm-lane-count">{count}</span>
          {onToggle ? (
            <button
              type="button"
              className="hm-lane-collapse"
              onClick={() => onToggle(lane.id)}
              aria-label={`Collapse ${lane.name} lane`}
            >
              collapse ‹
            </button>
          ) : null}
        </div>
        {lane.action ? <div className="hm-lane-action">{lane.action}</div> : null}
      </div>
      <div className="hm-lane-body">
        {count === 0 ? (
          <div className="hm-lane-empty">
            No {lane.name.toLowerCase()} right now.
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
