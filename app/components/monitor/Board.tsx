"use client";

// Hermes Handoff Monitor — Board (lane grid)
//
// Renders the `.hm-lanes` grid that contains every lane. The wrapping
// `.hm-board` root and `.hm-main` / `.hm-lanes-wrap` containers live
// in the page component — Board only owns the lanes themselves.
//
// M2: ships with a static expansion preset and no card rendering.
// M3 wires `renderCard` for the actual card components; M4 drives
// the expansion preset off live board mode.

import { useState, useCallback } from "react";
import { Lane, type LaneDescriptor, type LaneId } from "./Lane";
import type { BoardCard, Lane as LaneKey } from "@/lib/monitor/card-types.js";

// Lane catalogue — the eight lanes the monitor renders, in display
// order. The first six are "live" lanes (work in progress); the
// seventh is release-queue (merge-ready); the eighth is done
// (release history).
export const LANE_DESCRIPTORS: readonly LaneDescriptor[] = [
  { id: "needs-attention", name: "Needs attention", action: "Review decision waiting", isAction: true },
  { id: "drafts",          name: "Drafts",          action: "Author finishes" },
  { id: "codex-needed",    name: "Codex needed",    action: "Create / approve task" },
  { id: "hermes-checking", name: "Hermes checking", action: "Pre-check in flight" },
  { id: "operator-review", name: "Operator review", action: "Risk decision" },
  { id: "release-queue",   name: "Release queue",   action: "Branch protection" },
  { id: "deploying",       name: "Deploying",       action: "Verifying post-merge" },
  { id: "done",            name: "Done",            action: "Release history" },
] as const;

/** Expansion preset for the calm / empty state (A5 in the bundle). */
export const CALM_EXPANDED: ReadonlySet<LaneId> = new Set(["done"]);

/** Expansion preset for the default rich-mix state (A1 in the bundle). */
export const DEFAULT_EXPANDED: ReadonlySet<LaneId> = new Set([
  "hermes-checking",
  "operator-review",
  "release-queue",
  "deploying",
  "done",
]);

/** Expansion preset when an action card is in flight (A2). */
export const ACTION_EXPANDED: ReadonlySet<LaneId> = new Set([
  "operator-review",
  "hermes-checking",
  "deploying",
  "done",
]);

export type BoardProps = {
  /** Lane → card[] grouping from `groupByLane(cards)`. */
  grouped: Record<LaneKey, BoardCard[]>;
  /** Lanes that should render expanded (rest collapse to mini-rails). */
  initialExpanded?: ReadonlySet<LaneId>;
  /** Optional renderer for a single card. M3 supplies the card components. */
  renderCard?: (card: BoardCard) => React.ReactNode;
};

export function Board({ grouped, initialExpanded = DEFAULT_EXPANDED, renderCard }: BoardProps) {
  const [expanded, setExpanded] = useState<Set<LaneId>>(() => new Set(initialExpanded));

  const onToggle = useCallback((id: LaneId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="hm-lanes" role="region" aria-label="Lane grid">
      {LANE_DESCRIPTORS.map((lane) => {
        const cards = grouped[lane.id] ?? [];
        const isExpanded = expanded.has(lane.id);
        return (
          <Lane
            key={lane.id}
            lane={lane}
            expanded={isExpanded}
            count={cards.length}
            onToggle={onToggle}
          >
            {renderCard ? cards.map(renderCard) : null}
          </Lane>
        );
      })}
    </div>
  );
}
