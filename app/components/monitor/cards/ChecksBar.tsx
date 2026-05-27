"use client";

// Hermes Handoff Monitor — ChecksBar
//
// Compact progress bar showing the pass / running / fail / pending
// breakdown of a card's CI checks. Each segment is rendered as a
// fixed-width inline-block whose width is the segment's fraction of
// the total. The .hm-checks-bar CSS supplies the per-state colors
// (sage for pass, amber for running, rose for fail, neutral for
// pending) via class hooks.

import type { CardChecks } from "@/lib/monitor/card-types.js";

export type ChecksBarProps = {
  checks: CardChecks;
};

export function ChecksBar({ checks }: ChecksBarProps) {
  // Defensive: if `total` is 0 (or missing), recompute from the
  // segment breakdown so the bar renders sensibly. A card with no
  // total field has either lost its CI data or is a non-CI card —
  // either way we don't want a NaN-width segment.
  const total =
    checks.total > 0
      ? checks.total
      : checks.pass + checks.running + checks.fail + checks.pending;

  if (total <= 0) return null;

  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <div className="hm-checks-bar" aria-label={`${checks.pass} of ${total} checks passed`}>
      {checks.pass > 0 ? (
        <span className="pass" style={{ width: pct(checks.pass) }} aria-hidden />
      ) : null}
      {checks.running > 0 ? (
        <span className="running" style={{ width: pct(checks.running) }} aria-hidden />
      ) : null}
      {checks.fail > 0 ? (
        <span className="fail" style={{ width: pct(checks.fail) }} aria-hidden />
      ) : null}
      {checks.pending > 0 ? (
        <span className="pending" style={{ width: pct(checks.pending) }} aria-hidden />
      ) : null}
    </div>
  );
}
