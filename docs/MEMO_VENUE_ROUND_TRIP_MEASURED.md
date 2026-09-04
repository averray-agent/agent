# MEMO — The venue round trip, measured end to end

Status: **COMPLETE — deployment 4 opened 2026-08-30, closed 2026-09-03** ·
Author: Claude (architect) · Recorded 2026-09-03.
Answers `MEMO_SEPT4_DECISION_TREE.md`, whose thresholds were fixed before this
data existed.

## The measurement

The pool's own books are authoritative. `venuePrincipalCostBasis` began at
4.500000 and ends at **0.051490** — the unrecovered principal *is* the cost.

| | USDC |
|---|---|
| left the pool | 4.500000 |
| reached the venue as aUSDC | 4.450000 |
| **entry cost** | **0.050000** |
| requested back | 4.450000 |
| returned to the pool | **4.448510** |
| **exit cost** | **0.001490** |
| **ROUND TRIP** | **0.051490** |

Epoch-3 prior was **0.129576**, so the lane is **2.5× cheaper** than the
commitment ladder assumed — but not the 5.4× an intermediate reading suggested.

Deployed 2026-08-30 ~13:00Z, settled 2026-09-03 ~12:13Z: **~4.97 days** at
4.5 deployed, earning roughly 0.0069 — far below the 0.051490 of friction. This
deployment was always a measurement, never an investment, and it closed
wash-negative by design.

**Both swap legs filled at exact par** (`Swapped3`, AAVE filler, in = out).
Friction is transport and XCM fee, **never slippage** — which is why it is
roughly flat per round trip rather than proportional to size.

## The correction that matters

Mid-ceremony I reported entry friction as **0.022464** and a round trip of
**0.023954**, giving a 7-day break-even of 11.05 — and concluded v2.1 already
cleared it and **v2.2 should be shelved**.

That was wrong. **0.022464 measured transport plus sell execution only**; it
never captured the full gap between what left the pool (4.500000) and what
reached the venue (4.450000). The true entry cost is **0.050000**.

**A partial friction figure nearly drove a contract-scoping decision.** The
guard against it is the one used here: take the number from the pool's own
residual cost basis, not from an intermediate leg reading.

## Break-even at the measured round trip

| window | deployable USDC to break even |
|---|---|
| 7 days | **23.76** |
| 30 days | **5.54** |
| 90 days | **1.85** |

v2.1 holds **14.478654**. So **30-day and 90-day windows are viable at today's
pool size; 7-day is short by about 9.3 USDC.**

Break-even is not profit. A lane worth running wants a real multiple of these.

## What this means for the fork

The scale-versus-duration fork from the decision tree **stays open**, but both
arms are now cheap:

- **Scale** — about **10 more USDC** of deployable capital makes 7-day windows
  viable with **no contract change**.
- **Duration** — v2.2 plus commitment tracking makes 30-day windows viable
  **today**, at 5.54 break-even against 14.478654 held.

The prior claim that longer windows were blocked by *friction* is dead: at
0.051490, 30-day and 90-day clear comfortably. What still blocks them is the
contract — `deployToVenue` caps at `NOTICE_7_DAYS` because any holder may
`requestRedeem(…, Notice7Days)`, and that needs commitment tracking, not a
constant edit.

## Still true, and still the real constraint

**v2.1 has no venue adapter** (`venueAdapter() == address(0)`), so no deposit in
the live pool can earn anything regardless of this measurement. **Ceremony B is
the gate**, and it is owner-gated by the 2-of-3 multisig.

## Caveats held deliberately

1. **One round trip.** Entry measured once, exit once. The 33× gap between
   entry (0.050000) and exit (0.001490) is unexplained — plausibly a one-time
   setup cost on the way in, but that is a hypothesis, not a finding.
2. **Small size.** 4.5 deployed. Nothing here proves friction stays flat at 25
   or 100 USDC, though par fills on both legs are suggestive.
3. **No rate may be published** from a single round trip.
