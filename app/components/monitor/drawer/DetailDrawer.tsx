"use client";

// Hermes Handoff Monitor — DetailDrawer
//
// Unified drawer that branches on card type/state. Mirrors the
// bundle's `Drawer` component 1:1. Layered over the board via a
// portal-style fixed-position scrim; clicking the scrim closes;
// pressing Escape closes; j/k traverses cards while staying in
// the drawer scope.
//
// The mission body is the heaviest variant and lands in its own
// component (`MissionDrawerBody` — M6 milestone). For M5, every
// other card type renders through this drawer.

import { useEffect, useRef } from "react";
import type { BoardCard } from "@/lib/monitor/card-types.js";
import { ChecksBar } from "@/components/monitor/cards/ChecksBar";

export type DetailDrawerProps = {
  card: BoardCard;
  /** Close handler (esc, scrim click, or close button). */
  onClose: () => void;
  /** j/k traversal handlers — caller provides next/prev card ids. */
  onNext?: () => void;
  onPrev?: () => void;
};

export function DetailDrawer({ card, onClose, onNext, onPrev }: DetailDrawerProps) {
  // Capture the previously-focused element so we can restore focus
  // when the drawer closes (per §11 of the spec).
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Move focus into the drawer.
    drawerRef.current?.focus();
    return () => {
      // Restore focus to whatever opened us.
      previouslyFocused.current?.focus?.();
    };
  }, []);

  // Keyboard handler for drawer scope. Per §12 of the spec:
  //   esc       → close
  //   j / ↓     → next card
  //   k / ↑     → prev card
  //
  // Input-focus rule: if a textarea/input owns focus inside the
  // drawer (e.g. operator-note textarea, future Ask Hermes
  // composer), only `Escape` is honored.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = !!target && /INPUT|TEXTAREA/.test(target.tagName);
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (inInput) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        if (onNext) {
          e.preventDefault();
          onNext();
        }
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        if (onPrev) {
          e.preventDefault();
          onPrev();
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNext, onPrev]);

  const accent = pickAccent(card);

  return (
    <div
      className="hm-drawer-scrim"
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={drawerRef}
        className="hm-drawer"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Detail drawer for ${card.id} — ${card.title}`}
        onClick={(e) => e.stopPropagation()}
        style={{ borderLeftColor: accent.border }}
      >
        <DrawerHead card={card} accent={accent} onClose={onClose} />
        <DrawerBody card={card} />
        <DrawerFooter card={card} />
      </aside>
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────

type Accent = {
  color: string;
  border: string;
  pill: string;
  label: string;
};

function pickAccent(card: BoardCard): Accent {
  const isClosed = card.type === "done";
  const isDraft = card.isDraft === true;
  const isMission = card.type === "mission";
  const isAction = card.isAction === true;

  if (isMission) {
    return {
      color: "var(--hm-hermes-deep)",
      border: "var(--hm-hermes)",
      pill: "hm-pill--hermes",
      label: "Browser mission · agent report",
    };
  }
  if (isAction) {
    return {
      color: "var(--hm-amber-deep)",
      border: "var(--hm-amber)",
      pill: "hm-pill--risk",
      label: "Operator review · risk decision",
    };
  }
  if (isClosed) {
    return {
      color: "var(--hm-sage-deep)",
      border: "var(--hm-sage)",
      pill: "hm-pill--ok",
      label: "Closed · in release history",
    };
  }
  if (isDraft) {
    return {
      color: "var(--hm-muted)",
      border: "var(--hm-muted)",
      pill: "hm-pill--draft",
      label: "Draft · author finishes",
    };
  }
  return {
    color: "var(--hm-sage-deep)",
    border: "var(--hm-sage)",
    pill: "hm-pill--ok",
    label: "Automation in flight",
  };
}

function DrawerHead({
  card,
  accent,
  onClose,
}: {
  card: BoardCard;
  accent: Accent;
  onClose: () => void;
}) {
  const closedAt = (card as { closedAt?: string }).closedAt;
  const mission = (card as { mission?: { verdict?: string; confidence?: number } }).mission;
  const subline = subForCard(card, closedAt, mission);

  return (
    <header className="hm-drawer-head">
      <div className="hm-drawer-eyebrow">
        <span className={"hm-pill " + accent.pill}>{accent.label}</span>
        <span
          style={{
            color: accent.color,
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
            letterSpacing: 0,
            textTransform: "none",
            fontSize: 11,
          }}
        >
          {subline}
        </span>
        <button
          type="button"
          className="close"
          onClick={onClose}
          aria-label="Close drawer (esc)"
        >
          esc · close
        </button>
      </div>
      <h2 className="hm-drawer-title">{card.title}</h2>
      <div className="hm-drawer-meta">
        <span>
          <span style={{ color: "var(--hm-muted-soft)" }}>id</span>{" "}
          <span style={{ color: "var(--hm-ink)" }}>{card.id}</span>
        </span>
        <span>
          <span style={{ color: "var(--hm-muted-soft)" }}>repo</span>{" "}
          <a>{card.repo}</a>
        </span>
        {card.branch ? (
          <span>
            <span style={{ color: "var(--hm-muted-soft)" }}>branch</span>{" "}
            {card.branch}
          </span>
        ) : null}
        <span>
          <span style={{ color: "var(--hm-muted-soft)" }}>author</span>{" "}
          {card.agentType ?? "codex"}/coding-hand-3
        </span>
        <a>open on github ↗</a>
      </div>
    </header>
  );
}

function subForCard(card: BoardCard, closedAt?: string, mission?: { verdict?: string; confidence?: number }): string {
  if (card.type === "mission" && mission) {
    return `verdict · ${mission.verdict ?? "—"} · confidence ${mission.confidence ?? "—"}`;
  }
  if (card.type === "done") {
    return `merged · ${closedAt ?? ""}`;
  }
  if (card.isAction) {
    return "fresh · waiting on you";
  }
  if (card.waitingOn) {
    return `waiting on → ${card.waitingOn.actor}`;
  }
  return "";
}

// ── Body ────────────────────────────────────────────────────────────

function DrawerBody({ card }: { card: BoardCard }) {
  // Mission body lands in M6; for M5 we render a placeholder so the
  // mission cards are still openable but show a stubbed body.
  if (card.type === "mission") {
    return (
      <div className="hm-drawer-body">
        <MissionPlaceholderBody />
        <FilesSection card={card} />
        <OperatorNoteSection />
      </div>
    );
  }
  return (
    <div className="hm-drawer-body">
      <StatusSection card={card} />
      <FilesSection card={card} />
      {card.isAction ? <ChecksSection card={card} /> : null}
      {card.isAction ? <OperatorChecklist /> : null}
      <OperatorNoteSection />
    </div>
  );
}

function MissionPlaceholderBody() {
  return (
    <section>
      <div className="hm-section-h">Browser mission report</div>
      <div className="hm-verdict-block" style={{ background: "var(--hm-paper-2)" }}>
        <div className="head" style={{ color: "var(--hm-muted)" }}>
          MISSION REPORT — DETAIL VIEW LANDS IN M6
        </div>
        <div className="body">
          The full mission drawer (verdict, path, blockers, evidence,
          mutation-boundary, recommendations) ships in M6. For M5 the
          mission card opens this stub so the drawer flow is complete
          end-to-end across every card type. Use Ask Hermes (M7) for
          additional context until the full report renders here.
        </div>
      </div>
    </section>
  );
}

function StatusSection({ card }: { card: BoardCard }) {
  const verdict = (card as { verdict?: string }).verdict;
  if (card.type === "done") {
    const closedAt = (card as { closedAt?: string }).closedAt;
    const verdictText = (card as { verdictText?: string }).verdictText;
    return (
      <section>
        <div className="hm-section-h">Final verdict · release history</div>
        <div className="hm-verdict-block">
          <div className="head" style={{ color: "var(--hm-sage-deep)" }}>
            MERGED · in mainnet
          </div>
          <div className="body">
            {verdictText ?? "GitHub reports this PR is merged; this handoff is history."}
            <br />
            <br />
            Closed at <b>{closedAt}</b>. Deploy verification clean. No follow-up actions queued.
          </div>
        </div>
      </section>
    );
  }
  if (card.isAction && verdict) {
    return (
      <section>
        <div className="hm-section-h">Hermes verdict</div>
        <div className="hm-verdict-block">
          <div className="head">PROOF · code-level pre-check passed</div>
          <div className="body">
            {verdict}
            <br />
            <br />
            <b>Boundary:</b> staging worker only — mainnet config not
            touched. <b>Rollback:</b> revert merge commit; no on-chain
            state changes.
          </div>
        </div>
      </section>
    );
  }
  // Default: in-flight / stale / draft cards
  const summary = card.summary || "No additional context yet.";
  return (
    <section>
      <div className="hm-section-h">Status</div>
      <div
        className="hm-verdict-block"
        style={{ background: "var(--hm-paper-2)", borderColor: "var(--hm-line)" }}
      >
        <div className="head" style={{ color: "var(--hm-muted)" }}>
          {summary.toUpperCase().slice(0, 60)}
        </div>
        <div className="body">{summary}</div>
      </div>
    </section>
  );
}

function FilesSection({ card }: { card: BoardCard }) {
  const files = (card as { files?: { path: string; diff: string; critical: boolean }[] }).files;
  if (!files || files.length === 0) return null;
  return (
    <section>
      <div className="hm-section-h">Files &amp; risk signals</div>
      <div className="hm-files">
        {files.map((f) => (
          <div className="row" key={f.path}>
            <span className="path">{f.path}</span>
            <span className="diff">{f.diff}</span>
            {f.critical ? (
              <span className="hm-pill hm-pill--risk">review-gated</span>
            ) : (
              <span className="hm-pill hm-pill--neutral">docs</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ChecksSection({ card }: { card: BoardCard }) {
  if (!card.checks) return null;
  const { pass, total, fail, running } = card.checks;
  const heading =
    fail > 0
      ? `Checks · ${pass}/${total} passed · ${fail} fail`
      : running > 0
        ? `Checks · ${pass}/${total} passed · ${running} still running`
        : `Checks · ${pass}/${total} passed`;
  return (
    <section>
      <div className="hm-section-h">{heading}</div>
      <ChecksBar checks={card.checks} />
    </section>
  );
}

function OperatorChecklist() {
  // M5 ships static checklist content; M9+ wires per-card persistence
  // through `localStorage`. The visual is the bundle's contract.
  return (
    <section>
      <div className="hm-section-h">Operator checklist</div>
      <div className="hm-checklist">
        <div className="row done">
          <span className="box">✓</span>
          <span>Code pre-check (Hermes)</span>
          <span className="hint">auto</span>
        </div>
        <div className="row done">
          <span className="box">✓</span>
          <span>Review-gated file diff scanned</span>
          <span className="hint">auto</span>
        </div>
        <div className="row">
          <span className="box" />
          <span>Confirm new claim-stake floor is intended</span>
          <span className="hint">manual</span>
        </div>
        <div className="row">
          <span className="box" />
          <span>Confirm rollback story</span>
          <span className="hint">manual</span>
        </div>
        <div className="row">
          <span className="box" />
          <span>Confirm staging-only boundary holds</span>
          <span className="hint">manual</span>
        </div>
      </div>
    </section>
  );
}

function OperatorNoteSection() {
  // Card-level private operator notes are an add-on we deferred to
  // v1.1 (per the design call). For M5 the section renders a static
  // placeholder so the visual rhythm of the drawer matches the
  // bundle. v1.1 wires actual note storage.
  return (
    <section>
      <div className="hm-section-h">Operator note</div>
      <div
        className="hm-files"
        style={{
          padding: "10px 12px",
          fontFamily: "var(--font-body)",
          fontSize: 13,
          color: "var(--hm-muted)",
        }}
      >
        <span style={{ color: "var(--hm-muted-soft)", fontStyle: "italic" }}>
          Private to operator — not shared with agents. Click to add a note about this card.
        </span>
      </div>
    </section>
  );
}

// ── Footer ──────────────────────────────────────────────────────────

function DrawerFooter({ card }: { card: BoardCard }) {
  const isMission = card.type === "mission";
  const isClosed = card.type === "done";
  const isAction = card.isAction === true;

  return (
    <footer className="hm-drawer-foot">
      {isMission ? (
        <>
          <button type="button" className="hm-btn hm-btn--primary">
            Fresh run <span className="hm-kbd">R</span>
          </button>
          <button type="button" className="hm-btn hm-btn--ghost">
            Memory run
          </button>
          <button type="button" className="hm-btn hm-btn--ghost">
            Copy report
          </button>
          <button type="button" className="hm-btn hm-btn--action">
            Create product fix → Codex
          </button>
        </>
      ) : null}
      {isAction ? (
        <>
          <button type="button" className="hm-btn hm-btn--action">
            Approve &amp; merge <span className="hm-kbd">A</span>
          </button>
          <button type="button" className="hm-btn hm-btn--ghost">
            Send back to Codex <span className="hm-kbd">B</span>
          </button>
        </>
      ) : null}
      {isClosed ? (
        <>
          <button type="button" className="hm-btn hm-btn--ghost">
            View on github
          </button>
          <button type="button" className="hm-btn hm-btn--ghost">
            Copy receipt id
          </button>
        </>
      ) : null}
      {!isAction && !isClosed && !isMission ? (
        <button type="button" className="hm-btn hm-btn--primary">
          Open on github
        </button>
      ) : null}
      <button type="button" className="hm-btn hm-btn--ghost">
        Ask Hermes
      </button>
      <span className="spacer" />
      <span className="hm-mono hm-muted">j ‹ prev · k › next · esc close</span>
    </footer>
  );
}
