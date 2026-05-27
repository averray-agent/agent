"use client";

// Hermes Handoff Monitor — CardRouter
//
// React-side dispatch between Card and DegradedCard. The decision
// logic lives in `app/lib/monitor/card-router.js` (pure, tested);
// this component just consumes it.

import type { BoardCard } from "@/lib/monitor/card-types.js";
import { pickRenderer, defaultDegradedContent } from "@/lib/monitor/card-router.js";
import { Card } from "./Card";
import { DegradedCard } from "./DegradedCard";

export type CardRouterProps = {
  card: BoardCard;
  focused?: boolean;
  onClick?: (card: BoardCard) => void;
  /** Click handler for the degraded card's primary action (Retry / View cached). */
  onDegradedAction?: (card: BoardCard) => void;
};

export function CardRouter({ card, focused, onClick, onDegradedAction }: CardRouterProps) {
  const renderer = pickRenderer(card);

  if (renderer === "degraded") {
    const content = defaultDegradedContent(card);
    return (
      <DegradedCard
        card={card}
        body={content.body}
        pills={content.pills}
        action={content.action}
        onClick={onClick}
        onAction={onDegradedAction ? () => onDegradedAction(card) : undefined}
      />
    );
  }

  return <Card card={card} focused={focused} onClick={onClick} />;
}
