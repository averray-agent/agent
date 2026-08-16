# Packet — Arrivals legibility: answer the operator's question

**Date:** 2026-08-16 · **Author:** Claude (architect) · **Requested by:** Pascal ("this metric is
not the best… very confusing") · **Surfaces:** Hermes board arrivals section (monitor repo,
packages/monitor-ui) + the backend arrivals API that feeds it.
**Hard dependency:** the shared **self-identity registry** (task #233: operator wallets, canary
wallets incl. per-run ephemerals from evidence artifacts, the acceptance wallet, admin console
wallets, our own client names) — built once, consumed by flow funnel, arrivals, transparency.

## The defect

The section answers "how many API calls of each type per door." The operator's question is
"did any real stranger show up, how far did they get, and has that changed?" Concretely:
1. **No ours/outsider split on the HTTP series** — canaries + acceptance runs pollute the only
   funnel with real activity (+33 claimed on 2026-08-16 was ~all us).
2. **Stages count calls, not agents** — and the HTTP funnel is non-monotonic (evaluated 1730 >
   browsed 382) because stages sample different instrumentation points. A funnel whose numbers
   grow downward destroys trust in the whole board.
3. **The best element (furthest-outsider-stage) exists only for MCP** and hides the single most
   important historical fact: outsiders HAVE identified, worked, and settled via HTTP (the
   2026-08-11 42-payout day) and then stopped. The current UI cannot express "demand appeared
   and left," which is the truth the operator must see.

## The design (board aesthetic, verdict-first)

    ARRIVALS — WHO IS ACTUALLY SHOWING UP?

    OUTSIDERS                                        the only demand signal
      furthest ever:   SETTLED · 42 payouts in 12h · 2026-08-11 (HTTP)
      last activity:   5d ago — nothing from a stranger since
      this week:       3 identified · 0 worked
      posted work:     NEVER — the open gate (outreach #1 sent 2026-08-16)

    OURS — operational traffic, kept apart
      today: 5 canary runs · 1 acceptance run · admin console

    UNKNOWN / UNCLAIMABLE                                    counted apart
      shared client names 1 · pre-split calls 455

    DOORS — raw instrumentation                                 [expand ▸]
      (both current funnels, each row split outsider/ours/unknown;
       every window labeled; pre-identity stages marked "calls, not agents")

Rules:
- **Verdict band first.** One outsider block answering the question, including the historical
  furthest-ever with date and door, last-activity recency, and the posted-work NEVER line that
  ties directly to the 30-day outreach gate.
- **Identities, not calls, from `identified` onward.** Distinct wallets per stage per window.
  `reached`/`browsed` remain call counts (pre-identity, unavoidable) and must SAY so.
- **Every number carries its window** (24h / 7d / all-time badges). No bare deltas.
- **Doors are an attribute, not the organizing principle.** The per-door tables move into an
  expandable evidence drawer, each row split outsider/ours/unknown once the registry lands.
- **Truth-boundary:** self traffic must never render as demand; unknown must never be silently
  folded into either side; non-monotonic stage pairs must be labeled with their instrumentation
  point or removed.

## Acceptance
1. With registry data mocked, the verdict band renders the 2026-08-11 furthest-ever correctly
   from historical data (not hardcoded) and "posted work: NEVER" flips automatically on the
   first externally-posted job.
2. A day of pure canary/acceptance traffic renders OUTSIDERS "this week: 0 worked" while OURS
   shows the runs — the 2026-08-16 confusion becomes impossible.
3. Non-monotonic pairs are gone or labeled; every figure has a window badge.
4. Existing fixtures for the old layout updated; truth-boundary review against invented figures
   (design-handback law: no literals that don't come from the feed).
