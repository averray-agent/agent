# Packet — Board truth fixes: terminal XCM phases + honest revenue label

**Date:** 2026-08-17 · **Author:** Claude (architect) · **Implementer:** Codex
**Origin:** 2026-08-16 tunnel verification (task #233 items 1–2; items 3–4 shipped in #1147 + board #813).

## 1. Terminal buckets for failed XCM request phases
Both surfaces show the 2026-08-14 deliberately-failed recall requests as eternal in-flight:
- Hermes bank view (monitor repo): "5 in flight · oldest 0x380ef655… finalize-error for 2d ·
  UNRECOGNISED PHASE \"finalize-error\" on 0x3202b4d8…".
- Operator app XCM observer (platform repo): "Settle · 5 pending · last event error · block 0".
Fix: the request-state classifiers gain terminal buckets for FAILED/finalize-error phases —
rendered as closed-with-reason (failure code shown), never pending. Books were verified settled;
this is classification, not money. Placeholder "block 0" rows must render the reason instead.
Acceptance: the five 2026-08-14 requests render terminal on both surfaces; a genuinely pending
request still renders pending; an unknown NEW phase renders as "unrecognised — investigate",
loudly, never silently pending.

## 2. Honest revenue line (monitor repo)
"Protocol revenue (fees) — 5% poster-side fee" is stale: the figure (treasury AAC liquid) now
carries gas retention too, and 0.10 of the current 0.39 is operator-self-paid (the CW-ratified
caveat: ensureJob couples poster-fee waiver to the onboarding flag, so non-waived curated jobs
pay the operator's own fee into the treasury).
Fix: label becomes "poster fees + gas retention"; add a breakout line "of which operator-self-
paid: X" derived from settlements whose poster ∈ the self-identity registry (#1147 exports it).
Truth-boundary: self-paid fees must never read as external revenue.
Acceptance: label updated; breakout computed from the registry, not hardcoded; a settlement by
an external poster moves only the external line.
