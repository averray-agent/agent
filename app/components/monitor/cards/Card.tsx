"use client";

// Hermes Handoff Monitor — Card (unified renderer)
//
// One component handles every "live" card type the monitor knows
// about (PR, Mission, Codex task, Deploy, Draft, Done). The visual
// differences between types are driven by which fields are
// populated, not by separate React components — the bundle's
// original pattern, mirrored 1:1.
//
// The two non-live states (`failed-fetch`, `source-offline`) render
// through `DegradedCard` instead of this component. `CardRouter`
// owns that dispatch.
//
// State variants this component handles:
//   - fresh     — normal card, full-saturation pulse rail
//   - warm      — same shell, slightly faded freshness label
//   - settling  — default appearance
//   - stale     — is-stale class; the bundle CSS desaturates and adds
//                 the "STALE Xh" badge
//   - running   — same as fresh (a running CI is just fresh with
//                 more running segments in the checks bar)
//   - done      — compressed historical layout (no risk pills, no
//                 checks bar, just header + closed-at timestamp)
//
// Action variants:
//   - isAction = true → amber wash + Hermes verdict + CTA buttons
//   - archiveHint = true → "archive in 4h?" tail line

import type {
  BoardCard,
  CardChecks,
  WaitingOn,
  RiskTag,
  AgentType,
} from "@/lib/monitor/card-types.js";
import { formatFreshness, freshnessTier } from "@/lib/monitor/urgency.js";
import { ChecksBar } from "./ChecksBar";

export type CardProps = {
  card: BoardCard;
  focused?: boolean;
  onClick?: (card: BoardCard) => void;
};

// ── Helpers (mirror the bundle's small inline helpers) ──────────────

function agentLabel(t: AgentType | undefined): string {
  if (t === "codex" || t === "claude" || t === "hermes") return t;
  return "ext";
}

/**
 * CSS class hook for the freshness pip. Maps to the bundle's
 * `is-fresh` / `is-warm` / `is-stale` modifiers.
 */
function freshClass(card: BoardCard): string {
  if (card.state === "stale") return "is-stale";
  const tier = freshnessTier(card.freshness);
  if (tier === "fresh") return "is-fresh";
  if (tier === "warm") return "is-warm";
  return "";
}

/**
 * Strip the leading agent-type prefix from a card ID for the
 * monospace badge. `agent #548` → `#548`, `mission browser-X` →
 * `browser-X`, `task starter-X` → `starter-X`.
 */
function shortId(id: string): string {
  return id.replace(/^[a-z]+ /, "");
}

// Risk-tag pill classification — matches the bundle's branching.
const HIGH_RISK_TAGS = new Set<RiskTag>([
  "contracts",
  "workflow",
  "review-gated",
  "secrets",
  "config",
]);
const SECRET_RISK_TAGS = new Set<RiskTag>(["secrets"]);

function riskPillClass(tag: RiskTag): string {
  if (SECRET_RISK_TAGS.has(tag)) return "hm-pill hm-pill--secret";
  if (HIGH_RISK_TAGS.has(tag)) return "hm-pill hm-pill--risk";
  return "hm-pill hm-pill--neutral";
}

// ── Card ───────────────────────────────────────────────────────────

export function Card({ card, focused = false, onClick }: CardProps) {
  const isAction = Boolean(card.isAction);
  const isStale = card.state === "stale";
  const isClosed = card.type === "done";

  const classes = [
    "hm-card",
    isAction ? "hm-card--action" : "",
    isStale ? "is-stale" : "",
    focused ? "is-focused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Pull the card-type-specific tail fields where they exist. The
  // discriminated union means these are narrow per branch; we read
  // them defensively because the same Card renders every type.
  const verdict = (card as { verdict?: string }).verdict;
  const action = (card as { action?: { primary: string; secondary?: string } }).action;
  const checks: CardChecks | undefined = card.checks;
  const closedAt = (card as { closedAt?: string }).closedAt;
  const verdictText = (card as { verdictText?: string }).verdictText;

  const onCardClick = onClick
    ? () => onClick(card)
    : undefined;

  return (
    <div
      className={classes}
      onClick={onCardClick}
      // Focusable so j/k traversal can land on this card; the
      // Board's keyboard handler reads document.activeElement.
      // tabIndex=-1 means it's reachable programmatically but
      // doesn't enter the natural tab order (tab would otherwise
      // cycle through dozens of cards). j/k handles board traversal.
      tabIndex={-1}
      data-card-id={card.id}
      role={onClick ? "button" : "article"}
      aria-label={`${agentLabel(card.agentType)} ${shortId(card.id)} — ${card.title}`}
    >
      <CardHead card={card} isStale={isStale} isClosed={isClosed} />

      <div className="hm-card-title">{card.title}</div>

      {card.summary && !isClosed ? (
        <div
          className="hm-card-meta"
          style={{ lineHeight: 1.5 }}
        >
          <span
            style={{
              color: "var(--hm-ink-soft)",
              fontFamily: "var(--font-body)",
              fontSize: 12,
            }}
          >
            {card.summary}
          </span>
        </div>
      ) : null}

      {isClosed && verdictText ? (
        <div className="hm-card-meta">
          <span className="hm-mono">{closedAt}</span>
          <span className="sep">·</span>
          <span style={{ color: "var(--hm-ink-soft)" }}>{verdictText}</span>
        </div>
      ) : null}

      {!isClosed && card.risk && card.risk.length > 0 ? (
        <div className="hm-pillrow">
          {card.risk.map((r) => (
            <span key={r} className={riskPillClass(r)}>
              {r}
            </span>
          ))}
          {card.isDraft ? (
            <span className="hm-pill hm-pill--draft">draft</span>
          ) : null}
        </div>
      ) : null}

      {checks ? (
        <div className="hm-checks">
          <ChecksBar checks={checks} />
          <ChecksLabel checks={checks} />
        </div>
      ) : null}

      {card.waitingOn ? <WaitingOnLine waitingOn={card.waitingOn} /> : null}

      {isAction && verdict ? (
        <div className="hm-verdict">
          <span className="label">Hermes verdict</span>
          {verdict}
        </div>
      ) : null}

      {isAction && action ? (
        <div className="hm-card-cta">
          <button
            type="button"
            className="hm-btn hm-btn--action hm-btn--sm"
            onClick={(e) => e.stopPropagation()}
          >
            {action.primary}
            <span className="hm-kbd">A</span>
          </button>
          {action.secondary ? (
            <button
              type="button"
              className="hm-btn hm-btn--ghost hm-btn--sm"
              onClick={(e) => e.stopPropagation()}
            >
              {action.secondary}
            </button>
          ) : null}
        </div>
      ) : null}

      {card.archiveHint ? (
        <div
          className="hm-waiting hm-waiting--neutral"
          style={{ color: "var(--hm-muted-soft)" }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              textTransform: "none",
              letterSpacing: 0,
              fontWeight: 500,
              fontSize: 11,
            }}
          >
            Hermes: archive in 4h?{" "}
            <span
              style={{
                color: "var(--hm-sage-deep)",
                cursor: "pointer",
                borderBottom: "1px dotted",
              }}
            >
              Keep watching
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ── Card header — agent dot + ID + freshness pill ──────────────────

function CardHead({
  card,
  isStale,
  isClosed,
}: {
  card: BoardCard;
  isStale: boolean;
  isClosed: boolean;
}) {
  const formatted = formatFreshness(card.freshness);
  const freshnessLabel = isClosed
    ? "CLOSED"
    : isStale
      ? `STALE ${formatted ?? ""}`
      : `FRESH ${formatted ?? ""}`;

  return (
    <div className="hm-card-head">
      <span className="hm-card-id">
        <span
          className={`agent-dot agent-dot--${card.agentType ?? "ext"}`}
          aria-hidden
        />
        <span className="hm-mono">{agentLabel(card.agentType)}</span>
        <strong className="hm-mono">{shortId(card.id)}</strong>
      </span>
      <span className={"hm-card-fresh " + freshClass(card)}>
        <span className="fresh-dot" aria-hidden />
        {freshnessLabel}
      </span>
    </div>
  );
}

// ── Checks label (e.g. "5/6 · 1 running") ──────────────────────────

function ChecksLabel({ checks }: { checks: CardChecks }) {
  return (
    <span className="hm-checks-label">
      {checks.pass}/{checks.total}
      {checks.fail > 0 ? (
        <span style={{ color: "var(--hm-rose)" }}>
          {" · "}
          {checks.fail} fail
        </span>
      ) : null}
      {checks.running > 0 ? (
        <span style={{ color: "var(--hm-amber-deep)" }}>
          {" · "}
          {checks.running} running
        </span>
      ) : null}
    </span>
  );
}

// ── Waiting-on line ────────────────────────────────────────────────

function WaitingOnLine({ waitingOn }: { waitingOn: WaitingOn }) {
  return (
    <div className={`hm-waiting hm-waiting--${waitingOn.tone}`}>
      waiting on
      <span className="target">→ {waitingOn.actor}</span>
    </div>
  );
}
