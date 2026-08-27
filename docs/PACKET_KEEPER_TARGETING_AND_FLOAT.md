# PACKET — Keeper targeting + float sizing (both found in production)

Status: READY FOR CODEX · 2026-08-27 · Author: Claude (architect+gate) ·
Repo: **platform, mcp-server** · One PR (same subsystem).
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` R3/R4 and **Q3, which this answers with
measured data**. No contract changes. Both defects were found by running the
keeper against real money on 2026-08-27.

## Defect 1 — the keeper allocated the reward bank

`createRewardBankHealthProvider` derives the **reward bank** from the
settlement signer's AAC USDC `liquid` (`signerFunding`). That is
`0x5a6836c6D4d293F6E5377E6c28054F4171915813` — the same wallet the keeper
allocated from. Live result: liquid 16.073522 → **2.000000**, i.e. the reward
bank was drained to exactly the keeper's generic 2.0 headroom, which is not a
reward-runway floor and matched the bank floor only by coincidence. Recovered
manually by revoke + deallocate.

**Fix:** the settlement signer (and any wallet serving as an operator funding
source) must be **structurally excluded from keeper allocation targeting**,
regardless of consent state. Its liquid is working capital that funds every
reward the platform pays; "idle" is the wrong classification for it.

Do **not** implement this by raising the headroom:
`IDLE_BALANCE_ALLOCATION_WORKING_HEADROOM_RAW` is **global**, so a
reward-sized floor would apply to every external agent and defeat the product.

Exclusion must not break exit: an excluded wallet with an existing position
must still be able to deallocate. Exit is never gated — same law as consent.

## Defect 2 — an absolute float target cannot aggregate at small scale

`DEFAULT_FLOAT_TARGET_RAW` is a fixed 10.000000 USDC. With 4.073522 allocated,
`#manageFloat` computed a deficit against that absolute target and issued
`requestFloatExit` for the adapter's **entire** pool position.

Live evidence — pool `redeemRequests(1)`: owner `0x1DDcA709…` (the adapter),
shares **4.073522** (100% of the position), matures **2026-09-03T12:41:12Z**,
7-day notice tier, unfulfilled.

When that matures, pool assets fall 14.478654 → 10.405132 and
`maxDeployableAssets` returns 4.570257 → ~0.496735. **The aggregation undoes
itself, and the R2 exemption proven this morning is neutralised.**

**Fix: size the float RELATIVE to allocated assets, not absolutely.** The
float exists to back R4's synchronous-exit promise, which is inherently a
*proportion* of what holders could withdraw — not a constant. Suggested shape
(operator-confirmable, not a constant to bake in): float target =
`min(absoluteCap, pct × adapter.totalAssets)`, defaulting to something like
25%, so aggregation always retains the majority while instant exit stays real.
Flag the chosen percentage in the PR as an **operator decision at rollout**,
the way headroom/tick were.

**Handle the in-flight request.** Redeem request 1 matures 2026-09-03. State
plainly in the handback what the new logic does when it matures — fulfil then
re-sweep the excess, or leave it — and make sure the outcome is not "pull
everything out, then push most of it back", which burns two notice cycles.

## Non-negotiables (each pinned by a test)

1. The settlement signer is never selected for allocation, even with active
   consent — asserted by name/config, and proven by mutation (add a consent
   for it, assert zero allocations).
2. An excluded wallet can still **deallocate** an existing position.
3. With allocated assets below the absolute cap, the float request takes a
   **fraction**, never 100% — pin with the exact live numbers: 4.073522
   allocated must not produce a 4.073522 exit request.
4. Float still fully backs a synchronous exit up to its size (R4 unchanged).
5. Float management still runs before the consent scan and independent of
   whether any consent exists (current behaviour — do not regress it; it is
   what made the automatic refill fire at all).
6. No contract, consent, or allocation-accounting changes.

## Handback

PR number; green CI; the six test names; the chosen float percentage flagged
as an operator decision; and an explicit statement of what happens to redeem
request 1 on 2026-09-03.
